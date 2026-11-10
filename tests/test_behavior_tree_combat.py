"""正常输入、定点坐标与停止清理；实机伤害证据另存任务目录。"""
import pytest

from tools.gm_console.runtime_gm_code import read_runtime_gm_source


@pytest.fixture
def combat():
    lua = pytest.importorskip('lupa').LuaRuntime(unpack_returned_tuples=True)
    lua.execute(read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0] + '''
        typeof=function(value) return value end
        clock=0;calls={};moves={}
        CS={XFightState={Fight='Fight'},XInputControl={ForceClickForDebug=false},
            XNpcOperationClickKey={NormalAttackKey=15,DodgeKey=16,ExSkillKey=17,BallIndex1=1},
            XOperationClickType={KeyDown=1,KeyUp=2},XNpcAttribType={Life=0},
            XNpcTargetType={Enemy=1},XFightBallControl={DEFAULT_BALL_LAYER=0},
            XInputTouch={},System={Convert={ToInt32=function(v) return v end,ToByte=function(v) return v end}},
            XRLManager={Camera={GetEulerY=function() return 0 end}},UnityEngine={}}
        CS.UnityEngine.Vector2=setmetatable({zero={x=0,y=0}},{__call=function(_,x,y) return {x=x,y=y} end})
        CS.XNpcManager={CheckTargetType=function(p,n) return p.Camp~=n.Camp end}
        player={Id=1,Camp=1,IsActivate=true,IsDead=false,IsDeleted=false,SkillGroupComponent={},
            Position={x='0: 123',y='0: 456'}}
        enemy={Id=3,Name='enemy',Camp=2,IsActivate=true,IsDead=false,IsDeleted=false,
            Position={x='10: 789',y='0: 456'},Attrib={[0]={Value=100}},RLNpc={ShowHp=true}}
        utility={Id=2,Name='utility',Camp=1,IsActivate=true,Position={x=1,y=0}}
        local touch={SetMoveVec=function(_,vec,power) moves[#moves+1]={x=vec.x,y=vec.y,power=power} end}
        fight={State='Fight',Frame=1,GetClientRole=function() return {Npc=player} end,
            InputSystem={GetDevice=function() return touch end},
            InputControl={OnClick=function(_,key,kind,force) assert(force==false);calls[#calls+1]={key=key,kind=kind} end},
            NpcManager={GetNpcTable=function() return {GetEnumerator=function()
                local i=0;local values={utility,enemy};local it={}
                function it:MoveNext() i=i+1;self.Current={Value=values[i]};return values[i]~=nil end
                return it
            end} end}}
        player.FightBallControl={GetFightContainerCount=function() return 2 end,
            GetFightBallContainerData=function(_,_,index) return {IsReady=true,GroupItemCount=index==1 and 3 or 1} end}
        function context(action)
            return {params={role='player',output='result',distance=3,timeout=2,action=action,holdSeconds=0.08},
                memory={},now=0,object=function() return fight end,write=function(_,v) result=v end}
        end
        input=BehaviorTreeHandlers.fight_input
        approach=BehaviorTreeHandlers.fight_approach
        observe=BehaviorTreeHandlers.fight_observe
        compare=BehaviorTreeHandlers.blackboard_compare
        enemyWindow=BehaviorTreeHandlers.fight_enemy_window
        recent=BehaviorTreeHandlers.fight_recent_skill
        ballReady=BehaviorTreeHandlers.fight_ball_ready
        encodeResult=function() return BehaviorTreeJson.encode(result) end
        ctx=context('attack')
        function startHeld()
            bt=CreateBehaviorTree({now=function() return clock end,scene=function() return 's' end,send=function() end},BehaviorTreeDefinitions,BehaviorTreeHandlers)
            local token=bt.registerObject('player','fight','player',fight,function() return true end,{'fight.input'})
            local tree={schemaVersion=1,id='held',root='input',blackboard={},roles={player={kind='fight'}},nodes={
                {id='input',type='fight_input',version=1,children={},params={role='player',output='result',action='attack',holdSeconds=1}}}}
            bt.handle({protocolVersion=1,requestId='install',action='install',payload={tree=tree}})
            bt.handle({protocolVersion=1,requestId='run',action='start',payload={treeId='held',bindings={player=token}}})
            bt.update()
        end
    ''')
    return lua


def test_approach_parses_live_fixed_coordinates_and_releases(combat):
    combat.execute("assert(approach(ctx)=='running');assert(result.npcId==3 and moves[1].x==1)")
    combat.execute("player.Position.x='8: 123';assert(approach(ctx)=='succeeded');assert(moves[2].power==0)")


@pytest.mark.parametrize('cause', ['timeout', 'capability', 'enemy_dead'])
def test_approach_failure_releases_owned_movement(combat, cause):
    combat.execute("assert(approach(ctx)=='running')")
    combat.execute({'timeout': 'ctx.now=2', 'capability': 'fight.ShieldOperation=true', 'enemy_dead': 'enemy.IsDead=true'}[cause])
    combat.execute("assert(approach(ctx)=='failed');assert(moves[#moves].power==0 and ctx.memory.cleanup==nil)")


def test_ball_chooses_ready_group_and_submits_normal_key_pair(combat):
    combat.execute("ctx=context('ball');assert(input(ctx)=='running');assert(calls[1].key==2 and calls[1].kind==1)")
    combat.execute("ctx.now=0.1;assert(input(ctx)=='succeeded');assert(#calls==2 and calls[2].kind==2)")


def test_unavailable_ball_fails_without_submitting(combat):
    combat.execute("player.FightBallControl=nil;ctx=context('ball');assert(input(ctx)=='failed' and #calls==0)")


def test_stop_releases_only_owned_key_once(combat):
    combat.execute("startHeld();assert(#calls==1);bt.handle({protocolVersion=1,requestId='stop',action='stop',payload={}})")
    combat.execute("assert(bt.runs.run.state=='stopped');assert(#calls==2 and calls[2].kind==2);bt.update();assert(#calls==2)")


def test_lost_capability_releases_held_key(combat):
    combat.execute("assert(input(ctx)=='running');fight.ShieldOperation=true;assert(input(ctx)=='failed');assert(#calls==2 and calls[2].kind==2)")
