"""真实Lua导航：完整路线、当前地形、普通输入门禁与有限进展重算。"""
import pytest

from tools.gm_console.runtime_gm_code import read_runtime_gm_source


@pytest.fixture
def navigation():
    lua = pytest.importorskip('lupa').LuaRuntime(unpack_returned_tuples=True)
    lua.execute(read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0] + """
        typeof=function(v) return v end
        moves={};calls={}
        CS={XInputTouch={},XInputControl={ForceClickForDebug=false},XFightState={Fight='Fight'},
            XNpcOperationClickKey={NormalAttackKey=15},XOperationClickType={KeyDown=1,KeyUp=2},
            System={},UnityEngine={},XRLManager={Camera={GetEulerY=function() return 0 end}}}
        CS.UnityEngine.Vector2=setmetatable({zero={x=0,y=0}},{__call=function(_,x,y) return {x=x,y=y} end})
        player={Id=1,IsActivate=true,SkillGroupComponent={}}
        local touch={SetMoveVec=function(_,vec,power) moves[#moves+1]={x=vec.x,y=vec.y,power=power} end}
        fight={Frame=1,State='Fight',GetClientRole=function() return {Npc=player} end,
            InputSystem={GetDevice=function() return touch end},InputControl={OnClick=function() calls[#calls+1]=true end}}
        FixParse=tonumber
        CS.Mathematics={fix2=function() return {} end}
        CS.XNpcAction={BeHit=3}
        CS.System.Collections={Generic={List=function() return function() return {Count=0} end end}}
        player.Position={x=1,y=1};player.CanMove=function() return true end
        fight.InputControl.MoveOpState=true
        local touch=fight.InputSystem:GetDevice()
        touch.Disable=false
        blocked={};routeCalls=0;pathFound=true;routePoints={{x=5,y=1}}
        nav={GetCell=function(_,pos) return {x=math.floor(pos.x*2),y=math.floor(pos.y*2)} end,
            CheckCellObstacle=function(_,cell,y)
                local x=type(cell)=='table' and cell.x or cell
                y=y or cell.y
                return blocked[x..','..y]==true
            end,
            CheckLineObstacle=function() return false end}
        fight.Scene={ActiveTerrain={ThreeDMap=false},NavMesh=nav}
        fight.PathManager={PathFinder={Detour=function(_,from,to,list)
            routeCalls=routeCalls+1
            if followRequestedGoal then routePoints={{x=to.x,y=to.y}} end
            list.Count=#routePoints
            for i,p in ipairs(routePoints) do list[i-1]={x=p.x,y=p.y} end
            return pathFound,returnList and list or nil
        end}}
        ctx={memory={},now=0,object=function() return fight end,write=function(_,v) result=v end,
            run={blackboard={goal={x=5,y=1}}}}
        ctx.params={role='player',goalPath='goal',output='nav',timeout=10,
            arrivalTolerance=.2,stuckFrames=4,minProgress=.15,replanIntervalFrames=6,maxReplans=1}
        navigate=BehaviorTreeHandlers.fight_navigate
        createNavigationRuntime=function(host) return CreateBehaviorTree(host,BehaviorTreeDefinitions,BehaviorTreeHandlers) end
    """)
    return lua


def test_complete_route_follows_waypoints_and_actual_arrival_releases(navigation):
    navigation.execute("""
        blocked['6,2']=true
        routePoints={{x=1,y=3},{x=5,y=3},{x=5,y=1}};returnList=true
        assert(navigate(ctx)=='running' and moves[1].y==1)
        assert(result.waypointIndex==1 and #result.pathPoints==3)
        assert(result.source=='PathFinder.Detour' and routeCalls==1)
        assert(not result.clearanceKnown and not result.dynamicCollisionChecked and not result.threatChecked)
        player.Position={x=1,y=3};fight.Frame=2
        assert(navigate(ctx)=='running' and moves[#moves].x==1 and result.waypointIndex==2)
        player.Position={x=5,y=1};fight.Frame=3
        assert(navigate(ctx)=='succeeded' and result.phase=='arrived')
        assert(moves[#moves].power==0 and ctx.memory.cleanup==nil and #calls==0)
    """)


@pytest.mark.parametrize('points,reason', [
    ('{{x=5,y=1}}', 'path_partial'),
    ('{{x=1,y=3},{x=5,y=3},{x=5,y=1}}', 'path_partial'),
    ('{}', 'path_unreachable'),
])
def test_partial_route_never_moves_even_with_requested_endpoint(navigation, points, reason):
    navigation.execute(f"blocked['6,2']=true;pathFound=false;routePoints={points};assert(navigate(ctx)=='failed');assert(result.reason=='{reason}' and #moves==0 and routeCalls==1 and result.source=='PathFinder.Detour')")


def test_clear_short_target_uses_verified_direct_segment_without_astar(navigation):
    navigation.execute("""
        ctx.run.blackboard.goal={x=2,y=1}
        routePoints={{x=1,y=38},{x=2,y=1}}
        assert(navigate(ctx)=='running' and result.source=='direct_terrain')
        assert(routeCalls==0 and #result.pathPoints==1 and result.pathPoints[1].x==2)
        assert(moves[#moves].x==1)
        player.Position.x=2;fight.Frame=2
        assert(navigate(ctx)=='succeeded' and moves[#moves].power==0)
    """)


def test_short_blocked_target_rejects_disproportionate_detour_without_fallback(navigation):
    navigation.execute("""
        ctx.run.blackboard.goal={x=2,y=1};blocked['3,2']=true
        routePoints={{x=1,y=38},{x=2,y=1}}
        assert(navigate(ctx)=='failed' and result.reason=='path_detour_excess')
        assert(routeCalls==1 and #moves==0 and result.source=='PathFinder.Detour')
    """)


@pytest.mark.parametrize('setup,reason', [
    ('fight.Scene.ActiveTerrain.ThreeDMap=true', 'map_3d_unsupported'),
    ('fight.Scene.ActiveTerrain.ThreeDMap=nil', 'map_unknown'),
    ('fight.Scene.NavMesh=nil', 'navmesh_unknown'),
    ('ctx.run.blackboard.goal.x=0/0', 'goal_invalid'),
    ('fight.InputControl.MoveOpState=false', 'input_unavailable'),
    ('fight.InputSystem:GetDevice().Disable=true', 'input_unavailable'),
    ('player.CanMove=function() error("unreadable") end', 'control_unknown'),
])
def test_unknown_or_unsupported_never_becomes_clear(navigation, setup, reason):
    navigation.execute(f"{setup};assert(navigate(ctx)=='failed');assert(result.reason=='{reason}' and #moves==0)")


@pytest.mark.parametrize('cell', ['2,2', '10,2'])
def test_endpoint_obstacles_are_checked_separately_from_line_query(navigation, cell):
    navigation.execute(f"blocked['{cell}']=true;assert(navigate(ctx)=='failed');assert(result.reason=='terrain_blocked' and #moves==0)")


def test_unknown_terrain_and_path_results_never_move(navigation):
    navigation.execute("""
        local original=nav.CheckCellObstacle
        nav.CheckCellObstacle=function() return nil end
        assert(navigate(ctx)=='failed' and result.reason=='path_query_unknown' and #moves==0)
        nav.CheckCellObstacle=original;blocked['6,2']=true
        pathFound=nil;ctx.memory={}
        assert(navigate(ctx)=='failed' and result.reason=='path_result_unknown' and #moves==0)
    """)


def test_short_segment_and_diagonal_corner_are_checked(navigation):
    navigation.execute("""
        ctx.run.blackboard.goal={x=1.55,y=1};player.Position.x=1.3
        blocked['3,2']=true
        assert(navigate(ctx)=='failed' and #moves==0)
        blocked={['3,2']=true};ctx.memory={}
        player.Position={x=1.4,y=1.4};ctx.run.blackboard.goal={x=1.6,y=1.6}
        routePoints={{x=1.6,y=1.6}}
        assert(navigate(ctx)=='failed' and #moves==0)
    """)


def test_dynamic_obstacle_rechecks_active_segment_and_releases(navigation):
    navigation.execute("""
        assert(navigate(ctx)=='running');blocked['6,2']=true;fight.Frame=2
        assert(navigate(ctx)=='running' and result.reason=='terrain_blocked')
        assert(result.retryAfterFrame==7 and moves[#moves].power==0)
        fight.Frame=7;assert(navigate(ctx)=='failed' and result.reason=='terrain_blocked')
        assert(routeCalls==1 and ctx.memory.cleanup==nil)
    """)


def test_replans_are_bounded_and_same_frame_updates_do_not_count(navigation):
    navigation.execute("""
        assert(navigate(ctx)=='running')
        for i=1,20 do assert(navigate(ctx)=='running') end
        assert(routeCalls==0 and result.pathFrame==1 and result.progressFrames==0)
        fight.Frame=5;assert(navigate(ctx)=='running' and result.reason=='no_displacement')
        assert(moves[#moves].power==0)
        fight.Frame=6;assert(navigate(ctx)=='running' and result.reason=='replan_wait')
        fight.Frame=7;assert(navigate(ctx)=='running' and result.pathFrame==7 and routeCalls==0)
        fight.Frame=11;assert(navigate(ctx)=='failed' and result.reason=='replan_limit')
        assert(result.cause=='no_displacement' and moves[#moves].power==0)
    """)


def test_displacement_without_net_waypoint_advance_is_not_progress(navigation):
    navigation.execute("""
        navigate(ctx);player.Position.y=1.4;fight.Frame=5
        assert(navigate(ctx)=='running' and result.reason=='no_waypoint_advance')
        assert(result.displacement>.15 and result.advance<.15 and moves[#moves].power==0)
    """)


def test_reentry_backoff_expires_or_allows_a_different_goal(navigation):
    navigation.execute("""
        ctx.params.maxReplans=0;navigate(ctx);fight.Frame=5
        assert(navigate(ctx)=='failed' and result.reason=='replan_limit')
        local count=#moves
        ctx.memory={};fight.Frame=6
        assert(navigate(ctx)=='failed' and result.reason=='blocked_retry')
        assert(#moves==count and result.retryAfterFrame==11)
        ctx.memory={};ctx.run.blackboard.goal={x=4,y=1};routePoints={{x=4,y=1}}
        assert(navigate(ctx)=='running')
        ctx.memory.cleanup();ctx.memory={};fight.Frame=11
        ctx.run.blackboard.goal={x=5,y=1};routePoints={{x=5,y=1}}
        assert(navigate(ctx)=='running')
    """)


def test_geometric_failure_feedback_is_numeric_bounded_and_not_control_failure(navigation):
    navigation.execute("""
        player.CanMove=function() error('unknown') end
        assert(navigate(ctx)=='failed' and ctx.run.navigationFailures==nil)
        player.CanMove=function() return true end;pathFound=false;blocked['3,2']=true
        for frame=1,25 do
            ctx.memory={};fight.Frame=frame;ctx.run.blackboard.goal={x=frame+1,y=1}
            assert(navigate(ctx)=='failed')
        end
        assert(#ctx.run.navigationFailures==20)
        local first,last=ctx.run.navigationFailures[1],ctx.run.navigationFailures[20]
        assert(first.frame==6 and last.frame==25 and last.reason=='path_partial')
        assert(last.goal.x==26 and last.goal.y==1 and last.direction.x==1 and last.direction.y==0)
        ctx.run.blackboard.goal.x=99
        assert(last.goal.x==26)
        assert(navigate(ctx)=='failed' and #ctx.run.navigationFailures==20)
    """)


def test_action_lock_releases_and_resets_progress_without_wall_count(navigation):
    navigation.execute("""
        navigate(ctx);player.CanMove=function() return false end
        for frame=2,40 do fight.Frame=frame;assert(navigate(ctx)=='running') end
        assert(result.reason=='action_locked' and result.replans==0 and moves[#moves].power==0)
        player.CanMove=function() return true end;fight.Frame=41
        assert(navigate(ctx)=='running' and result.progressFrames==0)
        fight.Frame=44;assert(navigate(ctx)=='running' and result.reason==nil)
    """)


def test_control_and_input_lost_release_owned_movement(navigation):
    navigation.execute("""
        navigate(ctx);player.IsCaught=true;fight.Frame=2
        assert(navigate(ctx)=='running' and result.reason=='action_locked' and moves[#moves].power==0)
        player.IsCaught=false;fight.Frame=3;assert(navigate(ctx)=='running')
        fight.InputControl.MoveOpState=false;fight.Frame=4
        assert(navigate(ctx)=='failed' and result.reason=='input_unavailable' and moves[#moves].power==0)
    """)


def test_goal_is_copied_per_action_camera_transform_and_cleanup_is_local(navigation):
    navigation.execute("""
        CS.XRLManager.Camera.GetEulerY=function() return 90 end
        navigate(ctx);assert(math.abs(moves[1].x)<.00001 and moves[1].y>.99)
        ctx.run.blackboard.goal.x=9
        fight.Frame=2;navigate(ctx);assert(result.goal.x==5 and result.pathFrame==1 and routeCalls==0)
        local cleanup=ctx.memory.cleanup;ctx.memory.cleanup=nil;cleanup()
        assert(moves[#moves].power==0 and #calls==0)
    """)


def test_tracked_defense_goal_turn_is_consumed_without_reentering_branch(navigation):
    navigation.execute("""
        ctx.params.trackGoal=true;followRequestedGoal=true
        assert(navigate(ctx)=='running' and moves[#moves].x==1)
        local memory=ctx.memory
        ctx.memory.retryAfterFrame=20
        fight.Frame=2;ctx.run.blackboard.goal={x=-3,y=1}
        assert(navigate(ctx)=='running' and ctx.memory==memory)
        assert(result.goal.x==-3 and result.goalChangedFrame==2 and result.pathFrame==2 and routeCalls==0)
        assert(moves[#moves].x==-1 and ctx.memory.retryAfterFrame==nil and result.replans==0)
    """)


def test_tracking_micro_jitter_and_normal_goal_changes_are_throttled(navigation):
    navigation.execute("""
        ctx.params.trackGoal=true;followRequestedGoal=true
        navigate(ctx)
        ctx.run.blackboard.goal={x=6,y=1}
        navigate(ctx);assert(result.pathFrame==1)
        fight.Frame=2;navigate(ctx);assert(result.pathFrame==1)
        fight.Frame=3;navigate(ctx);assert(result.pathFrame==3 and result.goal.x==6)
        ctx.run.blackboard.goal={x=6.8,y=1};fight.Frame=4
        navigate(ctx);assert(result.pathFrame==3)
        ctx.run.blackboard.goal={x=6.05,y=1};fight.Frame=5
        navigate(ctx);assert(result.pathFrame==3 and result.goal.x==6)
        ctx.run.blackboard.goal={x=5.95,y=1};fight.Frame=6
        navigate(ctx);assert(result.pathFrame==3 and routeCalls==0)
    """)


def test_tracking_sharp_turn_below_distance_threshold_replans(navigation):
    navigation.execute("""
        ctx.params.trackGoal=true;followRequestedGoal=true
        ctx.run.blackboard.goal={x=1.4,y=1};navigate(ctx)
        fight.Frame=3;ctx.run.blackboard.goal={x=1,y=1.4}
        assert(navigate(ctx)=='running' and result.pathFrame==3 and routeCalls==0)
        assert(result.goal.y==1.4 and moves[#moves].y>.99)
    """)


def test_tracking_invalid_candidate_releases_instead_of_following_old_goal(navigation):
    navigation.execute("""
        ctx.params.trackGoal=true;navigate(ctx)
        ctx.run.blackboard.goal=nil;fight.Frame=2
        assert(navigate(ctx)=='failed' and result.reason=='goal_invalid')
        assert(routeCalls==0 and moves[#moves].power==0 and ctx.memory.cleanup==nil)
    """)


def test_tracking_goal_updates_preserve_total_timeout_and_stall_budget(navigation):
    navigation.execute("""
        ctx.params.trackGoal=true;followRequestedGoal=true
        navigate(ctx);ctx.memory.replans=1
        fight.Frame=3;ctx.now=1;ctx.run.blackboard.goal={x=6,y=1}
        assert(navigate(ctx)=='running' and result.pathFrame==3 and result.replans==1)
        fight.Frame=5;ctx.now=2;ctx.run.blackboard.goal={x=7,y=1}
        assert(navigate(ctx)=='running' and result.pathFrame==5 and result.replans==1)
        ctx.now=10;fight.Frame=7;ctx.run.blackboard.goal={x=8,y=1}
        assert(navigate(ctx)=='failed' and result.reason=='timeout')
        assert(routeCalls==0 and moves[#moves].power==0)
    """)


def test_timeout_capability_loss_and_bad_route_fail_with_cleanup(navigation):
    navigation.execute("""
        navigate(ctx);ctx.now=10
        assert(navigate(ctx)=='failed' and result.reason=='timeout' and moves[#moves].power==0)
        ctx.now=0;ctx.memory={};blocked['6,2']=true;routePoints={{x=1,y=3},{x=4,y=3}}
        assert(navigate(ctx)=='failed' and result.reason=='path_invalid')
        blocked={};routePoints={{x=5,y=1}};ctx.memory={};navigate(ctx);fight.ShieldOperation=true
        assert(navigate(ctx)=='failed' and result.reason=='movement_capability_lost' and moves[#moves].power==0)
    """)



def test_first_input_throw_after_mutation_is_released_by_real_kernel(navigation):
    navigation.execute("""
        local touch=fight.InputSystem:GetDevice()
        local original=touch.SetMoveVec
        touch.SetMoveVec=function(self,vec,power)
            original(self,vec,power)
            if power==1 then error('input_after_mutation') end
        end
        local bt=createNavigationRuntime({now=function() return 0 end,
            scene=function() return 'navigation-cleanup' end,send=function() end})
        local token=bt.registerObject('player','fight','player',fight,function() return true end,{'fight.navigate'})
        local tree={schemaVersion=1,id='throwing-nav',root='move',blackboard={goal={x=5,y=1}},
            roles={player={kind='fight'}},nodes={{id='move',type='fight_navigate',version=1,children={},
                params={role='player',goalPath='goal',output='navigation',timeout=2}}}}
        bt.handle({protocolVersion=1,requestId='install',action='install',payload={tree=tree}})
        bt.handle({protocolVersion=1,requestId='run',action='start',payload={treeId='throwing-nav',bindings={player=token}}})
        bt.update()
        local run=bt.runs.run
        assert(run.state=='error' and run.reason:find('input_after_mutation',1,true))
        assert(#moves==2 and moves[1].power==1 and moves[2].power==0)
        assert(#run.cleanupErrors==0 and run.memory.move==nil and #calls==0)
        bt.update();assert(#moves==2)
    """)
