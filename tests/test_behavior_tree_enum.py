"""枚举为Lua userdata且tonumber不可用，不能再用整数替身掩盖索引问题。"""
from pathlib import Path
import pytest
from tools.gm_console.runtime_gm_code import read_runtime_gm_source

def test_fight_read_converts_userdata_enums():
    lua=pytest.importorskip('lupa').LuaRuntime(unpack_returned_tuples=True)
    class Enum:
        pass
    life,energy=Enum(),Enum()
    calls=[]
    def convert(value):
        assert value is life or value is energy
        calls.append(value)
        return 1 if value is life else 2
    lua.globals().lifeEnum=life
    lua.globals().energyEnum=energy
    lua.globals().convertEnum=convert
    source=read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0]
    lua.execute(source+'''
assert(type(lifeEnum)=='userdata' and type(energyEnum)=='userdata')
assert(tonumber(lifeEnum)==nil and tonumber(energyEnum)==nil)
CS={XNpcAttribType={Life=lifeEnum,Energy=energyEnum},System={Convert={ToInt32=convertEnum}}}
local attrib={[1]={Value=225},[2]={Value=0}}
assert(not pcall(function()return attrib[lifeEnum].Value end))
local npc=setmetatable({Id=1,IsDeleted=false,IsDead=false,Attrib=attrib,Position='p',CurrentAction='a'},
 {__index=function(_,key)if key=='Life' or key=='Energy' then error('ByRef forbidden')end end})
local result
assert(BehaviorTreeHandlers.fight_read({params={role='player',output='state'},
 object=function()return {Frame=1,GetClientRole=function()return {Npc=npc}end}end,
 write=function(_,value)result=value end})=='succeeded')
assert(result.life==225 and result.energy==0)
''')
    assert calls==[life,energy]
