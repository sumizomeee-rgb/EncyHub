"""
GM Console - 协议解析器
解析 C# 协议文件，提取 Request/Response 定义和字段结构
"""
import os
import re
import json
import time
from typing import Optional


# ============================================================================
# 路径验证
# ============================================================================

def validate_haruroot(path: str) -> tuple[bool, str]:
    """验证 HaruRoot 路径是否有效（需要 Dev/Client 和 Product/Lua 两个子目录）"""
    if not path or not os.path.isdir(path):
        return False, "路径不存在"
    dev_client = os.path.join(path, "Dev", "Client")
    product_lua = os.path.join(path, "Product", "Lua")
    if not os.path.isdir(dev_client):
        return False, f"缺少 Dev/Client 目录 (期望: {dev_client})"
    if not os.path.isdir(product_lua):
        return False, f"缺少 Product/Lua 目录 (期望: {product_lua})"
    frontend_dir = os.path.join(path, "Dev", "Protocol", "Frontend")
    if not os.path.isdir(frontend_dir):
        return False, f"缺少 Dev/Protocol/Frontend 目录 (期望: {frontend_dir})"
    cs_files = [f for f in os.listdir(frontend_dir) if f.endswith(".cs")]
    if not cs_files:
        return False, f"Dev/Protocol/Frontend 下无 .cs 文件"
    return True, "有效"


# ============================================================================
# C# 类型系统映射
# ============================================================================

PRIMITIVE_TYPES = {
    "int", "long", "short", "byte", "sbyte",
    "uint", "ulong", "ushort",
    "float", "double", "decimal",
    "bool", "string",
}

# 简单别名（C# 类型 → 显示类型）
TYPE_ALIASES = {
    "int32": "int", "int64": "long", "float32": "float", "float64": "double",
}


def is_primitive_type(type_name: str) -> bool:
    """判断是否为基本类型"""
    t = type_name.lower().strip()
    if t in PRIMITIVE_TYPES or t in TYPE_ALIASES:
        return True
    # nullable 基本类型
    if t.startswith("nullable<"):
        inner = t[9:-1]
        return inner in PRIMITIVE_TYPES or inner in TYPE_ALIASES
    return False


def normalize_type(type_str: str) -> str:
    """规范化类型字符串"""
    return type_str.strip()


def parse_generic_type(type_str: str) -> dict:
    """解析泛型类型，如 List<int>, Dictionary<int,string>"""
    type_str = type_str.strip()
    # 匹配 GenericType<Inner>
    m = re.match(r'^(\w+)<(.+)>$', type_str)
    if not m:
        return {"raw": type_str, "isGeneric": False}

    outer = m.group(1)
    inner = m.group(2)

    # 处理嵌套尖括号：按逗号分割内层（考虑嵌套）
    inner_types = _split_generic_args(inner)

    if outer == "List":
        return {
            "raw": type_str,
            "isGeneric": True,
            "container": "list",
            "elementType": inner_types[0] if inner_types else "any",
            "isPrimitive": is_primitive_type(inner_types[0]) if inner_types else False,
        }
    elif outer in ("Dictionary", "Dict", "Map", "SortedDictionary"):
        return {
            "raw": type_str,
            "isGeneric": True,
            "container": "dict",
            "keyType": inner_types[0] if len(inner_types) > 0 else "any",
            "valueType": inner_types[1] if len(inner_types) > 1 else "any",
            "isPrimitive": False,
        }
    elif outer == "HashSet":
        return {
            "raw": type_str,
            "isGeneric": True,
            "container": "set",
            "elementType": inner_types[0] if inner_types else "any",
            "isPrimitive": False,
        }
    else:
        return {
            "raw": type_str,
            "isGeneric": True,
            "container": "other",
            "outerType": outer,
            "innerTypes": inner_types,
            "isPrimitive": False,
        }


def _split_generic_args(s: str) -> list:
    """分割泛型参数，考虑嵌套尖括号"""
    args = []
    depth = 0
    current = ""
    for ch in s:
        if ch == '<':
            depth += 1
            current += ch
        elif ch == '>':
            depth -= 1
            current += ch
        elif ch == ',' and depth == 0:
            args.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        args.append(current.strip())
    return args


# ============================================================================
# C# 文件解析
# ============================================================================

def parse_cs_file(filepath: str) -> list[dict]:
    """解析单个 C# 协议文件，提取所有类定义"""
    try:
        with open(filepath, 'r', encoding='utf-8-sig') as f:
            content = f.read()
    except Exception as e:
        print(f"[ProtoParser] 读取文件失败: {filepath}, error={e}")
        return []

    results = []
    # 提取所有 class/sealed class 定义
    # 模式: [attributes] public sealed class ClassName { ... }
    # 使用非贪婪匹配，逐个提取
    class_pattern = re.compile(
        r'(?:\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\]\s*)'  # 特性
        r'public\s+(?:sealed\s+)?class\s+(\w+)'                      # class 声明
        r'(?:\s*:\s*([^{]+?))?'                                       # 继承（可选，捕获）
        r'\s*\{',                                                      # 开大括号
        re.DOTALL
    )

    for m in class_pattern.finditer(content):
        class_name = m.group(1)
        base_classes_raw = m.group(2)
        start_pos = m.end()

        # 解析基类列表
        base_classes = []
        if base_classes_raw:
            for bc in base_classes_raw.split(','):
                bc = bc.strip()
                if bc and not bc.startswith('I') and '<' not in bc:
                    base_classes.append(bc)

        # 找到匹配的闭合大括号
        body = _extract_brace_block(content, start_pos)
        if body is None:
            continue

        # 提取 Route 特性
        route = _extract_route(content[:m.start()])

        # 提取注释
        comment = _extract_comment(content[:m.start()])

        # 提取字段
        fields = _extract_fields(body)

        # 提取 MessagePack 特性模式
        key_as_property = 'keyAsPropertyName' in content[:m.start() + 200] or 'true' in content[m.start() - 200:m.start()]

        results.append({
            "name": class_name,
            "route": route,
            "comment": comment,
            "fields": fields,
            "keyAsPropertyName": key_as_property,
            "baseClasses": base_classes,
        })

    return results


def _extract_brace_block(content: str, start: int) -> Optional[str]:
    """从 start 位置开始提取大括号匹配的块"""
    depth = 1
    i = start
    while i < len(content) and depth > 0:
        ch = content[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        elif ch == '"' or ch == "'":
            # 跳过字符串
            quote = ch
            i += 1
            while i < len(content) and content[i] != quote:
                if content[i] == '\\':
                    i += 1
                i += 1
        i += 1
    if depth == 0:
        return content[start:i - 1]
    return None


def _extract_route(text_before: str) -> Optional[str]:
    """从类定义之前的文本中提取 Route 特性"""
    # [Route(Receptor.GameServer)] 或 [Route(Receptor.GameServer, XFunctionId.Xxx)]
    m = re.search(r'\[Route\s*\(\s*Receptor\.(\w+)', text_before)
    if m:
        return m.group(1)
    return None


def _extract_comment(text_before: str) -> Optional[str]:
    """提取类前的 XML 注释"""
    m = re.search(r'///\s*<summary>\s*\n\s*///\s*(.+?)\s*\n\s*///\s*</summary>', text_before[-500:])
    if m:
        return m.group(1).strip()
    return None


def _extract_fields(body: str) -> list[dict]:
    """提取类体中的字段定义"""
    fields = []
    # 匹配: public TypeName FieldName; 或 public TypeName FieldName = default;
    # 也匹配: public List<int> FieldName = new List<int>();
    field_pattern = re.compile(
        r'public\s+'
        r'([\w<>,\s\?]+?)'     # 类型（含泛型）
        r'\s+'
        r'(\w+)'               # 字段名
        r'\s*(?:=\s*[^;]+)?;'  # 可选默认值
    )

    for m in field_pattern.finditer(body):
        type_str = normalize_type(m.group(1))
        field_name = m.group(2)

        # 跳过方法和属性
        if field_name.startswith("get_") or field_name.startswith("set_"):
            continue

        # 解析类型
        field_info = {
            "name": field_name,
            "type": type_str,
            "isPrimitive": is_primitive_type(type_str),
        }

        # 如果是泛型类型，额外解析
        if '<' in type_str:
            generic_info = parse_generic_type(type_str)
            field_info["genericInfo"] = generic_info
            field_info["isPrimitive"] = False

        fields.append(field_info)

    return fields


# ============================================================================
# 协议解析器主类
# ============================================================================

class ProtoParser:
    """协议解析器：扫描 C# 协议文件，构建协议索引"""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.cache_path = os.path.join(data_dir, "proto_cache.json")
        self.protocols = {}   # name → {name, route, comment, fields, keyAsPropertyName}
        self.types = {}       # type_name → {fields: [...]}
        self.haruroot = ""
        self.parse_time = 0
        self.protocol_count = 0

    def load_config(self) -> dict:
        """加载 HaruRoot 配置"""
        config_path = os.path.join(self.data_dir, "haruroot_config.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return {}

    def save_config(self, haruroot: str):
        """保存 HaruRoot 配置"""
        config_path = os.path.join(self.data_dir, "haruroot_config.json")
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump({"haruroot": haruroot}, f, ensure_ascii=False, indent=2)
        self.haruroot = haruroot

    def load_cache(self) -> bool:
        """加载缓存，返回是否有效"""
        if not os.path.exists(self.cache_path):
            return False
        try:
            with open(self.cache_path, 'r', encoding='utf-8') as f:
                cache = json.load(f)
            self.protocols = cache.get("protocols", {})
            self.types = cache.get("types", {})
            self.haruroot = cache.get("haruroot", "")
            self.parse_time = cache.get("parseTime", 0)
            self.protocol_count = len(self.protocols)
            return True
        except:
            return False

    def save_cache(self):
        """保存缓存"""
        os.makedirs(os.path.dirname(self.cache_path), exist_ok=True)
        cache = {
            "protocols": self.protocols,
            "types": self.types,
            "haruroot": self.haruroot,
            "parseTime": self.parse_time,
            "protocolCount": self.protocol_count,
        }
        with open(self.cache_path, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)

    def parse(self, haruroot: str) -> dict:
        """解析协议文件"""
        self.haruroot = haruroot
        self.protocols = {}
        self.types = {}

        frontend_dir = os.path.join(haruroot, "Dev", "Protocol", "Frontend")
        define_dir = os.path.join(haruroot, "Dev", "Protocol", "Define")

        # 1. 先解析 Define 目录，构建类型定义库
        if os.path.isdir(define_dir):
            for fname in os.listdir(define_dir):
                if not fname.endswith(".cs"):
                    continue
                fpath = os.path.join(define_dir, fname)
                classes = parse_cs_file(fpath)
                for cls in classes:
                    self.types[cls["name"]] = {
                        "fields": cls["fields"],
                        "comment": cls.get("comment"),
                        "baseClasses": cls.get("baseClasses", []),
                    }

        # 2. 解析 Frontend 目录，提取 Request 协议
        request_count = 0
        errors = []
        if os.path.isdir(frontend_dir):
            for fname in sorted(os.listdir(frontend_dir)):
                if not fname.endswith(".cs"):
                    continue
                fpath = os.path.join(frontend_dir, fname)
                try:
                    classes = parse_cs_file(fpath)
                    for cls in classes:
                        name = cls["name"]
                        self.protocols[name] = {
                            "name": name,
                            "route": cls.get("route"),
                            "comment": cls.get("comment"),
                            "fields": cls["fields"],
                            "baseClasses": cls.get("baseClasses", []),
                            "keyAsPropertyName": cls.get("keyAsPropertyName", True),
                            "source": fname,
                        }
                        if name.endswith("Request"):
                            request_count += 1
                except Exception as e:
                    errors.append(f"{fname}: {str(e)}")

        self.parse_time = time.time()
        self.protocol_count = len(self.protocols)
        self.save_cache()

        return {
            "total": self.protocol_count,
            "requests": request_count,
            "types": len(self.types),
            "errors": errors,
        }

    def search(self, query: str, limit: int = 50) -> list[dict]:
        """搜索协议（只返回 Request 类型的协议）"""
        q = query.lower().strip()
        results = []
        for name, proto in self.protocols.items():
            if not name.endswith("Request"):
                continue
            if q and q not in name.lower():
                continue
            results.append({
                "name": proto["name"],
                "route": proto.get("route", ""),
                "comment": proto.get("comment", ""),
                "fieldCount": len(proto.get("fields", [])),
            })
            if len(results) >= limit:
                break

        # 排序：优先匹配名称开头
        if q:
            results.sort(key=lambda x: (
                0 if x["name"].lower().startswith(q) else 1,
                x["name"]
            ))
        return results

    def get_detail(self, protocol_name: str, max_depth: int = 10) -> Optional[dict]:
        """获取协议详情（递归展开嵌套类型）"""
        proto = self.protocols.get(protocol_name)
        if not proto:
            return None

        # 递归展开字段（含继承）
        own_fields = proto.get("fields", [])
        inherited = []
        for base in proto.get("baseClasses", []):
            inherited.extend(self._get_inherited_fields(base))
        own_names = {f["name"] for f in own_fields}
        inherited = [f for f in inherited if f["name"] not in own_names]
        all_fields = inherited + own_fields
        expanded_fields = self._expand_fields(all_fields, max_depth=max_depth)

        # 尝试找到对应的 Response
        response_name = protocol_name.replace("Request", "Response")
        response_info = None
        if response_name in self.protocols:
            resp = self.protocols[response_name]
            response_info = {
                "name": resp["name"],
                "fields": self._expand_fields(resp.get("fields", []), max_depth=max_depth),
            }

        return {
            "name": proto["name"],
            "route": proto.get("route", ""),
            "comment": proto.get("comment", ""),
            "fields": expanded_fields,
            "response": response_info,
            "source": proto.get("source", ""),
        }

    def _expand_fields(self, fields: list, depth: int = 0, max_depth: int = 10, visited: set = None) -> list:
        """递归展开字段中的引用类型（含继承）"""
        if visited is None:
            visited = set()
        if depth >= max_depth:
            return [{"name": "...", "type": "max_depth_reached", "isPrimitive": True}]

        result = []
        for f in fields:
            field = dict(f)

            if not field.get("isPrimitive", True) and field["type"] not in visited:
                type_def = self.types.get(field["type"])
                if type_def:
                    visited_copy = visited | {field["type"]}
                    all_fields = self._get_inherited_fields(field["type"])
                    field["subFields"] = self._expand_fields(
                        all_fields, depth + 1, max_depth, visited_copy
                    )
                    field["typeComment"] = type_def.get("comment")

            result.append(field)
        return result

    def _get_inherited_fields(self, type_name: str, visited: set = None) -> list:
        """获取类型的所有字段（含继承链）"""
        if visited is None:
            visited = set()
        if type_name in visited:
            return []
        visited.add(type_name)

        type_def = self.types.get(type_name)
        if not type_def:
            return []

        inherited = []
        for base in type_def.get("baseClasses", []):
            inherited.extend(self._get_inherited_fields(base, visited))

        own_names = {f["name"] for f in type_def.get("fields", [])}
        inherited = [f for f in inherited if f["name"] not in own_names]

        return inherited + list(type_def.get("fields", []))

    def get_all_request_names(self) -> set:
        """获取所有 Request 协议名称集合（用于日志导入匹配）"""
        return {name for name in self.protocols if name.endswith("Request")}


# ============================================================================
# Lua Table 解析器（从日志文本提取）
# ============================================================================

def parse_lua_table(text: str) -> any:
    """解析 Lua table 文本为 Python 对象

    支持格式:
    - nil
    - 数字: 123, 1.5
    - 字符串: "abc", 'abc'
    - 布尔: true, false
    - 数组: {1, 2, 3} 或 {[1]=1, [2]=2}
    - 字典: {["Key"] = value, ...}
    """
    text = text.strip()
    if not text or text == "nil":
        return None
    parser = _LuaTableParser(text)
    return parser.parse_value()


class _LuaTableParser:
    """Lua table 文本解析器"""

    def __init__(self, text: str):
        self.text = text
        self.pos = 0

    def parse_value(self):
        """解析一个值"""
        self._skip_whitespace()
        if self.pos >= len(self.text):
            return None

        ch = self.text[self.pos]

        if ch == '{':
            return self._parse_table()
        elif ch == '"' or ch == "'":
            return self._parse_string()
        elif ch == '-' or ch.isdigit():
            return self._parse_number()
        elif self.text[self.pos:self.pos + 4] == 'true':
            self.pos += 4
            return True
        elif self.text[self.pos:self.pos + 5] == 'false':
            self.pos += 5
            return False
        elif self.text[self.pos:self.pos + 3] == 'nil':
            self.pos += 3
            return None
        else:
            # 未知值，跳过
            return None

    def _parse_table(self) -> dict:
        """解析 Lua table → Python dict（保持键值对形式）"""
        self.pos += 1  # skip {
        self._skip_whitespace()

        result = {}
        array_index = 1
        is_array = True  # 猜测是否为数组

        while self.pos < len(self.text):
            self._skip_whitespace()
            if self.pos >= len(self.text):
                break
            if self.text[self.pos] == '}':
                self.pos += 1
                break

            # 检查键类型
            if self.text[self.pos] == '[':
                # 显式键: ["Key"] = val 或 [1] = val
                key, val = self._parse_keyed_entry()
                if key is not None:
                    # 数字键
                    if isinstance(key, int):
                        result[str(key)] = val
                        if key != array_index:
                            is_array = False
                        array_index = key + 1
                    else:
                        result[str(key)] = val
                        is_array = False
            else:
                # 隐式数组: val, val, ...
                val = self.parse_value()
                result[str(array_index)] = val
                array_index += 1

            self._skip_whitespace()
            # 跳过逗号和分号
            if self.pos < len(self.text) and self.text[self.pos] in ',;':
                self.pos += 1

        # 如果全是连续数字键从1开始，转为列表
        if is_array and result:
            max_key = max(int(k) for k in result.keys())
            if max_key == len(result):
                return {"_isArray": True, "_items": [result[str(i)] for i in range(1, max_key + 1)]}

        return {"_isArray": False, "_items": result}

    def _parse_keyed_entry(self) -> tuple:
        """解析 ["Key"] = value 或 [1] = value"""
        self.pos += 1  # skip [

        self._skip_whitespace()
        # 解析键
        if self.text[self.pos] == '"' or self.text[self.pos] == "'":
            key = self._parse_string()
        elif self.text[self.pos] == '-' or self.text[self.pos].isdigit():
            key = self._parse_number()
            key = int(key) if isinstance(key, float) and key == int(key) else key
        else:
            key = None
            # 跳到 ]
            while self.pos < len(self.text) and self.text[self.pos] != ']':
                self.pos += 1

        self._skip_whitespace()
        if self.pos < len(self.text) and self.text[self.pos] == ']':
            self.pos += 1

        self._skip_whitespace()
        # 跳过 =
        if self.pos < len(self.text) and self.text[self.pos] == '=':
            self.pos += 1

        self._skip_whitespace()
        val = self.parse_value()
        return (key, val)

    def _parse_string(self) -> str:
        """解析字符串"""
        quote = self.text[self.pos]
        self.pos += 1
        result = ""
        while self.pos < len(self.text) and self.text[self.pos] != quote:
            if self.text[self.pos] == '\\':
                self.pos += 1
                if self.pos < len(self.text):
                    esc = self.text[self.pos]
                    if esc == 'n':
                        result += '\n'
                    elif esc == 't':
                        result += '\t'
                    elif esc == '\\':
                        result += '\\'
                    elif esc == quote:
                        result += quote
                    else:
                        result += esc
            else:
                result += self.text[self.pos]
            self.pos += 1
        if self.pos < len(self.text):
            self.pos += 1  # skip closing quote
        return result

    def _parse_number(self):
        """解析数字"""
        start = self.pos
        if self.text[self.pos] == '-':
            self.pos += 1
        while self.pos < len(self.text) and (self.text[self.pos].isdigit() or self.text[self.pos] == '.'):
            self.pos += 1
        # 科学计数法
        if self.pos < len(self.text) and self.text[self.pos] in 'eE':
            self.pos += 1
            if self.pos < len(self.text) and self.text[self.pos] in '+-':
                self.pos += 1
            while self.pos < len(self.text) and self.text[self.pos].isdigit():
                self.pos += 1

        num_str = self.text[start:self.pos]
        try:
            if '.' in num_str or 'e' in num_str.lower():
                return float(num_str)
            return int(num_str)
        except:
            return 0

    def _skip_whitespace(self):
        """跳过空白"""
        while self.pos < len(self.text) and self.text[self.pos] in ' \t\n\r':
            self.pos += 1


def lua_table_to_field_states(lua_value: any, protocol_fields: list = None) -> dict:
    """将解析后的 Lua table 转换为 fieldStates 格式

    Returns: {fieldPath: {mode, value?, markTable?}}
    """
    if lua_value is None:
        return {}

    field_states = {}
    _convert_lua_value(lua_value, "", field_states)
    return field_states


def _convert_lua_value(lua_value: any, prefix: str, field_states: dict):
    """递归转换 Lua table 到 fieldStates"""
    if lua_value is None:
        return

    if isinstance(lua_value, dict) and "_isArray" in lua_value:
        if lua_value["_isArray"]:
            items = lua_value["_items"]
            if prefix:
                field_states[prefix] = {"mode": "table", "markTable": True}
            for i, item in enumerate(items):
                _convert_lua_value(item, f"{prefix}[{i + 1}]", field_states)
        else:
            items = lua_value["_items"]
            if isinstance(items, dict):
                if prefix:
                    field_states[prefix] = {"mode": "table", "markTable": True}
                for key, val in items.items():
                    if isinstance(key, str) and key.isdigit():
                        child_prefix = f"{prefix}[{key}]"
                    else:
                        child_prefix = f"{prefix}.{key}" if prefix else key
                    if isinstance(val, dict) and "_isArray" in val:
                        _convert_lua_value(val, child_prefix, field_states)
                    elif isinstance(val, (dict,)):
                        field_states[child_prefix] = {"mode": "table", "markTable": True}
                    elif val is None:
                        field_states[child_prefix] = {"mode": "nil", "markTable": True}
                    else:
                        field_states[child_prefix] = {"mode": "value", "value": val, "markTable": not isinstance(val, (int, float, bool, str))}
    elif isinstance(lua_value, list):
        if prefix:
            field_states[prefix] = {"mode": "table", "markTable": True}
    elif isinstance(lua_value, dict):
        if prefix:
            field_states[prefix] = {"mode": "table", "markTable": True}
        for key, val in lua_value.items():
            if isinstance(key, str) and key.isdigit():
                child_prefix = f"{prefix}[{key}]"
            else:
                child_prefix = f"{prefix}.{key}" if prefix else key
            _convert_lua_value(val, child_prefix, field_states)
    else:
        # 基本类型
        if prefix:
            field_states[prefix] = {"mode": "value", "value": lua_value}


# ============================================================================
# 日志导入解析
# ============================================================================

# Send_Call 正则
# 格式: <Log> [2026/04/17 17:32:13.4777] <color=#5bf54f> Send_Call: ProtocolName, content: </color>{...}
SEND_CALL_PATTERN = re.compile(
    r'<Log>\s*\[([^\]]+)\]\s*<color=#5bf54f>\s*Send_Call:\s*(\w+),\s*content:\s*</color>'
)

MAX_LOG_SIZE = 50 * 1024 * 1024  # 50MB
MAX_LOG_LINES = 500000


def parse_log_file(filepath: str, known_protocols: set = None) -> dict:
    """解析日志文件，提取 Send_Call 请求记录

    Returns:
        {
            "fileName": str,
            "entries": [
                {
                    "index": int,          # 全局序号
                    "protocol": str,       # 协议名
                    "timestamp": str,      # 时间戳
                    "contentPreview": str, # 预览: "nil" / "{}" / "{N字段}"
                    "fieldCount": int,     # 字段数
                    "fieldStates": dict,   # 解析后的参数
                    "parseError": bool,    # 是否解析失败
                    "known": bool,         # 是否在已知协议列表中
                }
            ],
            "error": str | None,
            "sendCallCount": int,
            "recvCallCount": int,
        }
    """
    # 文件大小检查
    file_size = os.path.getsize(filepath)
    if file_size > MAX_LOG_SIZE:
        return {"error": f"文件过大 ({file_size / 1024 / 1024:.1f}MB)，限制 {MAX_LOG_SIZE / 1024 / 1024:.0f}MB",
                "entries": [], "fileName": os.path.basename(filepath), "sendCallCount": 0, "recvCallCount": 0}

    # 读取文件
    try:
        content = _read_file_with_fallback(filepath)
    except Exception as e:
        return {"error": f"读取文件失败: {e}", "entries": [], "fileName": os.path.basename(filepath),
                "sendCallCount": 0, "recvCallCount": 0}

    lines = content.split('\n')
    if len(lines) > MAX_LOG_LINES:
        lines = lines[:MAX_LOG_LINES]

    # 统计全文 Send_Call / Recv_Call 数量
    send_call_count = 0
    recv_call_count = 0
    for line in lines:
        if 'Send_Call:' in line:
            send_call_count += 1
        if 'Recv_Call:' in line:
            recv_call_count += 1

    if send_call_count == 0 and recv_call_count == 0:
        return {"error": "无法识别的日志格式：未找到 Send_Call 或 Recv_Call 记录",
                "entries": [], "fileName": os.path.basename(filepath), "sendCallCount": 0, "recvCallCount": 0}

    if send_call_count == 0 and recv_call_count > 0:
        return {"error": f"仅发现回复记录 (Recv_Call={recv_call_count})，未发现请求记录 (Send_Call=0)，请确认是否为正确的日志文件",
                "entries": [], "fileName": os.path.basename(filepath), "sendCallCount": 0, "recvCallCount": 0}

    # 重置计数，在下面的解析循环中重新统计
    send_call_count = 0
    recv_call_count = 0

    entries = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = SEND_CALL_PATTERN.search(line)
        if m:
            timestamp = m.group(1)
            protocol = m.group(2)
            send_call_count += 1

            # 提取 content：从 `</color>` 后到下一个空行或 `stack traceback`
            content_lines = []
            j = i + 1
            # 检查同行是否就是 content（如 nil 或 {}）
            after_color = line[m.end():].strip()
            if after_color:
                content_lines.append(after_color)
            # 读取后续行直到空行或 stack traceback
            while j < len(lines):
                next_line = lines[j].strip()
                if not next_line or next_line.startswith('stack traceback') or next_line.startswith('<Log>'):
                    break
                content_lines.append(next_line)
                j += 1

            content_text = '\n'.join(content_lines).strip()

            # 解析 content
            known = known_protocols is not None and protocol in known_protocols
            entry = {
                "index": len(entries) + 1,
                "protocol": protocol,
                "timestamp": _extract_time(timestamp),
                "contentPreview": "",
                "fieldCount": 0,
                "fieldStates": {},
                "parseError": False,
                "known": known,
            }

            if content_text == "nil" or not content_text:
                entry["contentPreview"] = "nil"
                entry["fieldStates"] = {}
            else:
                try:
                    parsed = parse_lua_table(content_text)
                    if parsed is None:
                        entry["contentPreview"] = "nil"
                    else:
                        fs = lua_table_to_field_states(parsed)
                        # 计算顶层字段数
                        top_fields = [k for k in fs if '.' not in k and '[' not in k]
                        entry["fieldCount"] = len(top_fields) if top_fields else len(fs)
                        entry["fieldStates"] = fs
                        if not top_fields and not fs:
                            entry["contentPreview"] = "{}"
                        elif len(top_fields) <= 3:
                            entry["contentPreview"] = "{" + ", ".join(top_fields) + "}"
                        else:
                            entry["contentPreview"] = "{" + ", ".join(top_fields[:3]) + f", ...}} ({len(top_fields)}字段)"
                except Exception as e:
                    entry["parseError"] = True
                    entry["contentPreview"] = f"(解析失败)"
                    print(f"[ProtoParser] Lua table 解析失败: protocol={protocol}, error={e}")

            entries.append(entry)
            i = j
        else:
            if 'Recv_Call:' in line:
                recv_call_count += 1
            i += 1

    return {
        "fileName": os.path.splitext(os.path.basename(filepath))[0],
        "entries": entries,
        "error": None,
        "sendCallCount": send_call_count,
        "recvCallCount": recv_call_count,
    }


def _extract_time(timestamp: str) -> str:
    """从日志时间戳提取时间部分"""
    # 格式: 2026/04/17 17:32:13.4777
    m = re.search(r'(\d{2}:\d{2}:\d{2})', timestamp)
    return m.group(1) if m else timestamp


def _read_file_with_fallback(filepath: str) -> str:
    """尝试多种编码读取文件"""
    encodings = ['utf-8-sig', 'utf-8', 'gbk', 'gb2312', 'latin1']
    for enc in encodings:
        try:
            with open(filepath, 'r', encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    raise Exception(f"无法用支持的编码读取文件")


# ============================================================================
# Lua 代码生成
# ============================================================================

def generate_lua_code(protocol_name: str, params: dict, mark_table_fields: list, nil_fields: list = None) -> str:
    """生成发送协议请求的 Lua 代码

    Args:
        protocol_name: 协议名
        params: 请求参数（嵌套 dict/list）
        mark_table_fields: 需要 MarkAsTable 的字段路径列表
        nil_fields: 不传的字段路径列表

    Returns:
        Lua 代码字符串
    """
    import time as _time
    import random as _random

    req_id = f"proto_{int(_time.time())}_{_random.randint(1000,9999)}"

    # 构建 request table
    request_lua = _build_lua_table(params, nil_fields or [], indent="    ")

    # 构建 MarkAsTable 调用（跳过 nil 路径）
    mark_lines = []
    for field_path in sorted(mark_table_fields):
        lua_path = f"_request.{field_path}"
        mark_lines.append(f"    if {lua_path} ~= nil then XMessagePack.MarkAsTable({lua_path}) end")

    mark_code = '\n'.join(mark_lines)

    code = f"""do
    local _reqId = "{req_id}"
    local _request = {request_lua}
{mark_code}
    XNetwork.Call("{protocol_name}", _request, function(response)
        if RuntimeGMClient then
            RuntimeGMClient.Send({{
                type = "PROTO_CALL_RESP",
                reqId = _reqId,
                protocol = "{protocol_name}",
                code = response.Code,
                data = response
            }})
        else
            print("[EncyHub] PROTO_CALL_RESP reqId=" .. _reqId .. " protocol={protocol_name} code=" .. tostring(response.Code))
        end
    end)
end"""

    return code


def _build_lua_table(data: any, nil_fields: list, indent: str = "    ") -> str:
    """将 Python 数据结构转为 Lua table 字面量"""
    if data is None:
        return "nil"

    if isinstance(data, bool):
        return "true" if data else "false"

    if isinstance(data, (int, float)):
        if isinstance(data, float) and data == int(data):
            return str(int(data))
        return str(data)

    if isinstance(data, str):
        # Lua 字符串转义
        escaped = data.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r')
        return f'"{escaped}"'

    if isinstance(data, list):
        if not data:
            return "{}"
        items = []
        for item in data:
            items.append(_build_lua_table(item, nil_fields, indent + "    "))
        if len(items) <= 5 and all(isinstance(x, (int, float, str, bool)) or x == "nil" for x in items):
            return "{" + ", ".join(items) + "}"
        inner = f",\n{indent}".join(items)
        return f"{{\n{indent}{inner}\n{indent[:-4]}}}"

    if isinstance(data, dict):
        if not data:
            return "{}"
        entries = []
        for key, val in data.items():
            if key in nil_fields:
                continue
            val_lua = _build_lua_table(val, nil_fields, indent + "    ")
            if isinstance(key, int) or (isinstance(key, str) and key.isdigit()):
                entries.append(f'{indent}[{key}] = {val_lua}')
            else:
                entries.append(f'{indent}["{key}"] = {val_lua}')
        if not entries:
            return "{}"
        inner = f",\n".join(entries)
        return f"{{\n{inner}\n{indent[:-4]}}}"

    return "nil"
