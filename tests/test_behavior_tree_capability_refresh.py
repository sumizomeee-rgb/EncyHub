"""同token发现能力必须同步注册表；输入能力失去不能重发。"""
import pytest
from tools.gm_console.runtime_gm_code import read_runtime_gm_source

def test_same_token_capability_add_remove_and_running_loss():
    lua=pytest.importorskip('lupa').LuaRuntime(unpack_returned_tuples=True)
    lua.execute(read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0]+'''
local sent={};local calls={}
CS={XFightState={Fight='Fight'},XInputControl={ForceClickForDebug=false},XNpcOperationClickKey={NormalAttackKey=15},XOperationClickType={KeyDown=1,KeyUp=2}}
local npc={IsActivate=false,IsDeleted=false,IsDead=false,SkillGroupComponent={}}
local player={Npc=npc}
local fight={State='Load',Frame=1,GetClientRole=function()return player end,InputControl={OnClick=function(_,key,click)calls[#calls+1]=click end}}
local host={now=function()return 0 end,scene=function()return 'fight-scene' end,send=function(p)sent[#sent+1]=p end}
local bt=CreateBehaviorTree(host,BehaviorTreeDefinitions,BehaviorTreeHandlers)
local function request(id,action,p)
 bt.handle({protocolVersion=1,requestId=id,action=action,payload=p});return sent[#sent]
end
local token=bt.registerObject('player','fight','player',fight,function()return true end,{'fight.read'})
local generation=token.generation
local tree={schemaVersion=1,id='attack',root='root',roles={player={kind='fight'}},blackboard={},nodes={
 {id='root',type='fight_normal_attack',version=1,params={role='player',output='attack',timeout=2,expectedSkillId=101},children={}}}}
assert(request('install','install',{tree=tree}).data.ok)
local function start(id)return request(id,'start',{treeId='attack',bindings={player=token}})end
assert(not start('load').ok and #calls==0)
fight.State='Fight';npc.IsActivate=true
assert(BehaviorTreeCapabilityChecks['fight.normal_attack'].available(fight))
local same=bt.registerObject('player','fight','player',fight,function()return true end,{'fight.read','fight.normal_attack'})
assert(same==token and same.generation==generation)
assert(start('active').ok)
bt.update();assert(#calls==2 and bt.runs.active.state=='running')
-- 已提交短按后失能力：节点失败，停止输入且不改变token。
npc.IsActivate=false
same=bt.registerObject('player','fight','player',fight,function()return true end,{'fight.read'})
assert(same==token and same.generation==generation and #bt.objects.player.capabilities==1)
bt.update();assert(bt.runs.active.state=='failed')
assert(bt.runs.active.blackboard.attack.reason=='input_capability_lost')
bt.update();assert(#calls==2)
request('stop','stop',{runId='active'})
local rejected=start('removed')
assert(not rejected.ok and rejected.error.message:find('binding_capability') and #calls==2)
-- 再获得能力仍复用同token；启动后、尚未提交前失能力直接failed。
npc.IsActivate=true
bt.registerObject('player','fight','player',fight,function()return true end,{'fight.read','fight.normal_attack'})
assert(start('before-submit').ok)
npc.IsActivate=false
bt.registerObject('player','fight','player',fight,function()return true end,{'fight.read'})
bt.update();assert(bt.runs['before-submit'].state=='failed' and #calls==2)
-- 空能力列表也替换旧集合，不能只合并新增能力。
bt.registerObject('player','fight','player',fight,function()return true end,{})
assert(#bt.objects.player.capabilities==0 and bt.objects.player.token.generation==generation)
''')
