"""普通头像输入共键：拒绝非激活窗口，并以队友真实 QTE 起手作为回执。"""
import pytest

from test_behavior_tree_combat import combat
from tools.gm_console.runtime_gm_code import read_runtime_gm_source


@pytest.fixture
def team(combat):
    combat.execute(read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0] + '''
        teamObserve=BehaviorTreeHandlers.fight_team_observe
        qte=BehaviorTreeHandlers.fight_qte
        CS.XNpcQteState={Cooldown=0,Ready=1,Activated=2,Running=3,None=4}
        CS.XNpcOperationClickKey.ChangeNpcIndexBegin=20
        role={Npc=player,ControlNpc=player,NoteTable={}}
        role.NoteTable.ContainsKey=function(self,key) return self[key]~=nil end
        player.Index=0;player.Role=role;player.TemplateId=14410036
        support={Id=2,Index=1,Role=role,TemplateId=13110036,IsActivate=false,
            IsDead=false,IsDeleted=false,QteState=2,SkillGroupComponent={}}
        other={Id=4,Index=2,Role=role,TemplateId=12110036,IsActivate=false,
            IsDead=false,IsDeleted=false,QteState=1,SkillGroupComponent={}}
        player.QteState=4;role.Captain=support
        role.NpcTable={[0]=player,[1]=support,[2]=other,Count=3}
        role.NoteTable[2022]=1;role.NoteTable[2042]=2;role.NoteTable[2052]=100
        fight.GetClientRole=function() return role end
        ctx.params.targetSlot=2;ctx.params.expectedTemplateId=13110036
        ctx.params.expectedSkillId=78031;ctx.params.timeout=1
        ctx.run={blackboard={}}
        function startQteTree()
            local originalRole,main=role,player
            bt=CreateBehaviorTree({now=function() return clock end,scene=function() return 's' end,
                send=function() end},BehaviorTreeDefinitions,BehaviorTreeHandlers)
            local token=bt.registerObject('player','fight','player',fight,function()
                return fight:GetClientRole()==originalRole and originalRole.Npc==main
            end,{'fight.qte'})
            local tree={schemaVersion=1,id='qte-test',root='qte',blackboard={},
                roles={player={kind='fight'}},nodes={
                {id='qte',type='fight_qte',version=1,children={},params={role='player',output='qte',
                    targetSlot=2,expectedTemplateId=13110036,expectedSkillId=78031,timeout=1}}}}
            bt.handle({protocolVersion=1,requestId='install',action='install',payload={tree=tree}})
            bt.handle({protocolVersion=1,requestId='run',action='start',payload={treeId='qte-test',bindings={player=token}}})
            bt.update()
        end
    ''')
    return combat


def test_team_snapshot_uses_npc_index_not_list_order_and_isolated_values(team):
    team.execute('''
        role.NpcTable[0],role.NpcTable[2]=other,player
        assert(teamObserve(ctx)=='succeeded')
        assert(result.known and result.count==3 and result.currentIndex==0 and result.activeMain)
        assert(result.captainIndex==1 and result.members['2'].canQte)
        assert(result.members['2'].noteIdentityKnown and result.members['2'].remainingFrames==99)
        local before=result
        support.QteState=0;role.NoteTable[2052]=20;teamObserve(ctx)
        assert(before.members['2'].qteState==2 and before.members['2'].remainingFrames==99)
        assert(result.members['2'].qteState==0 and not result.members['2'].canQte)
    ''')


@pytest.mark.parametrize('failure', [
    'support.QteState=1', 'support.QteState=0', 'support.QteState=3',
    'support.IsDead=true', 'support.IsDeleted=true', 'support.IsActivate=true',
    'role.NoteTable[2022]=0', 'role.NoteTable[2022]=nil',
    'role.NoteTable[2042]=99', 'role.NoteTable[2042]=nil',
    'role.NoteTable[2052]=nil', 'role.NoteTable[2052]=0/0',
    'role.NoteTable[2052]=math.huge', 'role.NoteTable[2052]=6',
    'ctx.params.expectedTemplateId=7', 'ctx.params.targetSlot=1',
])
def test_refuses_unactivated_stale_or_wrong_target_without_input(team, failure):
    team.execute(failure)
    team.execute("assert(qte(ctx)=='failed' and #calls==0)")


@pytest.mark.parametrize('failure', [
    'role.NpcTable.Count=4', 'support.Index=0', 'support.Index=3',
    'support.Role={}', 'role.NpcTable[1]=nil',
])
def test_unknown_team_cannot_be_observed_or_controlled(team, failure):
    team.execute(failure)
    team.execute("assert(teamObserve(ctx)=='failed' and result.known==false)")
    team.execute("assert(qte(ctx)=='failed' and #calls==0)")


def test_sends_one_normal_pair_for_zero_based_slot_and_no_repeats(team):
    team.execute('''
        role.NoteTable[2052]=7
        assert(qte(ctx)=='running' and result.phase=='input_submitted')
        assert(#calls==2 and calls[1].key==21 and calls[1].kind==1 and calls[2].kind==2)
        assert(ctx.memory.cleanup==nil)
        ctx.now=0.5;assert(qte(ctx)=='running' and #calls==2)
        ctx.now=1;assert(qte(ctx)=='failed' and result.reason=='no_qte_start_evidence')
        assert(not result.runningObserved and not result.skillStartObserved and #calls==2)
    ''')


@pytest.mark.parametrize('only', ['state', 'skill', 'wrong_skill', 'same_skill_no_restart'])
def test_needs_running_and_new_expected_skill_start(team, only):
    if only == 'same_skill_no_restart':
        team.execute('support.SkillGroupComponent.CurrentSkill={Id=78031,RunFrame=12}')
    team.execute("assert(qte(ctx)=='running')")
    team.execute({
        'state': 'support.QteState=3',
        'skill': 'support.SkillGroupComponent.CurrentSkill={Id=78031,RunFrame=0}',
        'wrong_skill': 'support.QteState=3;support.SkillGroupComponent.CurrentSkill={Id=78032,RunFrame=0}',
        'same_skill_no_restart': 'support.QteState=3;support.SkillGroupComponent.CurrentSkill.RunFrame=13',
    }[only])
    team.execute("ctx.now=1;assert(qte(ctx)=='failed' and result.reason=='no_qte_start_evidence')")


def test_real_start_with_reused_skill_object_is_observed_and_named(team):
    team.execute('''
        support.SkillGroupComponent.CurrentSkill={Id=78031,RunFrame=12}
        assert(qte(ctx)=='running')
        support.QteState=3;support.IsActivate=true
        support.SkillGroupComponent.CurrentSkill.RunFrame=0;fight.Frame=2
        assert(qte(ctx)=='succeeded' and result.phase=='qte_started')
        assert(result.targetSlot==2 and result.npcId==2 and result.templateId==13110036)
        assert(result.observedSkillId==78031 and result.runningObserved and result.skillStartObserved)
        assert(role.Npc==player and #calls==2)
        teamObserve(ctx)
        assert(result.members['2'].lastStartedFrame==2 and result.members['2'].lastStartedSkillId==78031)
    ''')


@pytest.mark.parametrize('change', [
    'role.Npc=other;role.ControlNpc=other;other.IsActivate=true',
    'role.NpcTable[2]={Id=4,Index=2,Role=role}',
    'support.IsDead=true', 'support.IsDeleted=true',
])
def test_team_or_main_change_aborts_without_further_inputs(team, change):
    team.execute("assert(qte(ctx)=='running')")
    team.execute(change)
    team.execute("assert(qte(ctx)=='failed' and #calls==2 and ctx.memory.cleanup==nil)")


def test_cleanup_is_registered_before_keydown_and_releases_only_owned_key(team):
    team.execute('''
        fight.InputControl.OnClick=function(_,key,kind,force)
            assert(not force);calls[#calls+1]={key=key,kind=kind}
            if kind==1 then error('submission failed') end
        end
        local ok=pcall(qte,ctx)
        assert(not ok and ctx.memory.cleanup)
        ctx.memory.cleanup();ctx.memory.cleanup=nil
        assert(#calls==2 and calls[2].key==21 and calls[2].kind==2)
    ''')


def test_note_read_failure_is_unknown_without_serializing_exception(team):
    team.execute('''
        role.NoteTable.ContainsKey=function() error('private diagnostic') end
        assert(teamObserve(ctx)=='succeeded' and not result.members['2'].canQte)
        assert(not result.members['2'].noteStateKnown and result.members['2'].noteState==nil)
        assert(qte(ctx)=='failed' and #calls==0)
    ''')


@pytest.mark.parametrize('stop', ['manual', 'main_changed'])
def test_kernel_stop_or_old_binding_invalidation_never_continues_after_qte_pair(team, stop):
    team.execute("startQteTree();assert(bt.runs.run.state=='running' and #calls==2)")
    if stop == 'manual':
        team.execute("bt.handle({protocolVersion=1,requestId='stop',action='stop',payload={}})")
    else:
        team.execute('role.Npc=other;role.ControlNpc=other;bt.update()')
    team.execute("assert(bt.runs.run.state=='stopped');bt.update();assert(#calls==2)")
    if stop == 'main_changed':
        team.execute("assert(bt.runs.run.reason=='object_destroyed')")


def test_catalog_validates_and_prevents_parallel_competing_inputs():
    from tools.gm_console.behavior_tree import validate_tree

    qte = {'id': 'qte', 'type': 'fight_qte', 'version': 1, 'children': [],
           'params': {'role': 'player', 'output': 'qte', 'targetSlot': 2,
                      'expectedTemplateId': 13110036, 'expectedSkillId': 78031}}
    tree = {'schemaVersion': 1, 'id': 'team', 'root': 'qte',
            'roles': {'player': {'kind': 'fight'}}, 'nodes': [qte]}
    assert validate_tree(tree)['ok']
    qte['params']['minimumWindowFrames'] = 5
    assert not validate_tree(tree)['ok']
    qte['params']['minimumWindowFrames'] = 6
    tree['root'] = 'parallel'
    tree['nodes'].extend([
        {'id': 'parallel', 'type': 'parallel', 'version': 1, 'params': {}, 'children': ['qte', 'attack']},
        {'id': 'attack', 'type': 'fight_input', 'version': 1, 'children': [],
         'params': {'role': 'player', 'output': 'attack', 'action': 'attack', 'holdSeconds': 0.08}},
    ])
    assert not validate_tree(tree)['ok']
