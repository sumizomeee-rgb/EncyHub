"""通用节点目录、树校验和游戏执行接口。"""
import json
import math
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

NODE_PATH = Path(__file__).with_name('behavior_tree_nodes.json')

def node_catalog():
    return json.loads(NODE_PATH.read_text(encoding='utf-8'))

def validate_tree(tree):
    errors = []
    def bad(path, message):
        errors.append({'path': path, 'message': message})
    if not isinstance(tree, dict) or tree.get('schemaVersion') != 1 or not isinstance(tree.get('id'), str):
        return {'ok': False, 'errors': [{'path': 'tree', 'message': 'invalid_schema'}]}
    nodes = tree.get('nodes')
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 256:
        return {'ok': False, 'errors': [{'path': 'nodes', 'message': 'node_limit'}]}
    def pure(value, active=None, depth=0):
        if depth > 64: return False
        if value is None or type(value) in (str, bool, int): return True
        if type(value) is float: return math.isfinite(value)
        if not isinstance(value, (dict, list)): return False
        active = set() if active is None else active
        if id(value) in active: return False
        active.add(id(value))
        valid = (not isinstance(value, dict) or all(isinstance(k, str) for k in value)) and all(pure(v, active, depth+1) for v in (value.values() if isinstance(value, dict) else value))
        active.remove(id(value))
        return valid
    roles = tree.get('roles', {})
    if not isinstance(roles, dict) or not all(isinstance(v, dict) for v in roles.values()):
        return {'ok': False, 'errors': [{'path': 'roles', 'message': 'invalid_roles'}]}
    if not isinstance(tree.get('blackboard', {}), dict) or not pure(tree.get('blackboard', {})):
        bad('blackboard', 'requires_pure_value')
    catalog = {n['id']: n for n in node_catalog()}
    index = {}
    for i, node in enumerate(nodes):
        path = f'nodes[{i}]'
        if not isinstance(node, dict):
            bad(path, 'invalid_node'); continue
        ident = node.get('id')
        if not isinstance(ident, str) or not ident or ident in index:
            bad(path, 'duplicate_or_invalid_id'); continue
        index[ident] = node
        definition = catalog.get(node.get('type')) if isinstance(node.get('type'), str) else None
        if not definition or node.get('version') != definition['version']:
            bad(path, 'unknown_node_or_version'); continue
        children = node.get('children', [])
        if not isinstance(children, list) or not all(isinstance(x, str) for x in children):
            bad(path+'.children', 'invalid_children'); continue
        if not definition['minChildren'] <= len(children) <= definition['maxChildren']:
            bad(path+'.children', 'child_count')
        params = node.get('params', {})
        if not isinstance(params, dict):
            bad(path+'.params', 'invalid_params'); continue
        if not pure(params): bad(path+'.params', 'requires_pure_value')
        if node.get('type') == 'parallel':
            for key in ('successThreshold', 'failureThreshold'):
                if type(params.get(key)) in (int, float) and params[key] > len(children): bad(path+'.params.'+key, 'threshold_exceeds_children')
        schema = definition['params']
        for key in schema['required']:
            if key not in params: bad(path+'.params.'+key, 'required')
        for key, value in params.items():
            rule = schema['properties'].get(key)
            if rule is None:
                bad(path+'.params.'+key, 'unknown_parameter'); continue
            typ = rule.get('type')
            valid = typ is None or (typ == 'string' and isinstance(value, str)) or (typ == 'boolean' and isinstance(value, bool)) or (typ == 'number' and type(value) in (int,float)) or (typ == 'integer' and type(value) is int)
            if not valid: bad(path+'.params.'+key, 'parameter_type'); continue
            if type(value) in (int,float) and (value < rule.get('minimum', float('-inf')) or value > rule.get('maximum', float('inf'))):
                bad(path+'.params.'+key, 'parameter_range')
            if 'enum' in rule and value not in rule['enum']: bad(path+'.params.'+key, 'parameter_enum')
        for role in definition['roles']:
            requirement = roles.get(params.get(role['parameter']), {}) if isinstance(params.get(role['parameter']), str) else {}
            if requirement.get('kind') != role['kind']: bad(path, 'role_kind')
    visited, active = set(), set()
    def walk(ident, depth):
        if not isinstance(ident, str) or ident not in index: bad('children', 'missing_node'); return
        if ident in active or depth > 64: bad(ident, 'cycle_or_depth'); return
        if ident in visited: bad(ident, 'multiple_parents'); return
        visited.add(ident); active.add(ident)
        children = index[ident].get('children', [])
        if isinstance(children, list):
            for child in children: walk(child, depth+1)
        active.remove(ident)
    walk(tree.get('root'), 1)
    for ident in index:
        if ident not in visited: bad(ident, 'unreachable')
    # 并行分支不能同时写同一黑板键或对象动作资源。
    def resources(ident):
        if ident not in index: return set()
        node = index[ident]; p = node.get('params', {})
        result = set()
        for resource in catalog.get(node.get('type'), {}).get('resources', []):
            result.add(resource['kind']+':'+str(p.get(resource['parameter'])))
        for child in node.get('children', []):
            if child not in active:
                active.add(child); result |= resources(child); active.remove(child)
        return result
    if not errors:
        for ident, node in index.items():
            if node['type'] == 'parallel':
                used = set()
                for child in node.get('children', []):
                    current = resources(child)
                    if used & current: bad(ident, 'parallel_resource_conflict')
                    used |= current
    return {'ok': not errors, 'errors': errors}

class RuntimeRequest(BaseModel):
    requestId: str | None = None
    sessionId: str | None = None
    payload: dict = Field(default_factory=dict)
    timeout: float = Field(default=10, ge=1, le=60)

def create_router(get_server):
    router = APIRouter(prefix='/behavior-tree')
    @router.get('/nodes')
    async def nodes():
        return {'nodes': node_catalog(), 'schemaVersion': 1}
    @router.post('/validate')
    async def validate(body: dict):
        return validate_tree(body.get('tree'))
    @router.post('/clients/{client_id}/{action}')
    async def execute(client_id: str, action: str, body: RuntimeRequest):
        if action not in {'capabilities','discover','validate','install','start','stop','status'}:
            raise HTTPException(400, 'unknown_action')
        if action in {'install','validate'}:
            result = validate_tree(body.payload.get('tree'))
            if not result['ok']: return result
        mgr = get_server()
        if not mgr: raise HTTPException(503, 'server_not_ready')
        return await mgr.behavior_tree_request(client_id, action, body.payload, body.requestId, body.sessionId, body.timeout)
    return router
