"""黑板候选方向仍经普通输入；提交不能冒充技能落点。"""
from test_behavior_tree_combat import combat


def test_direction_from_blackboard_is_normalized_and_released(combat):
    combat.execute("""
        ctx.run={blackboard={plan={direction={x=0,y=-3}}}}
        ctx.params.action='dodge';ctx.params.directionPath='plan.direction'
        assert(input(ctx)=='running' and #calls==0)
        assert(moves[1].x==0 and moves[1].y==-1)
        ctx.now=.04;assert(input(ctx)=='running' and #calls==1)
        assert(result.phase=='input_submitted' and result.directionY==-1)
        ctx.now=.2;assert(input(ctx)=='succeeded')
        assert(moves[#moves].power==0 and calls[#calls].kind==2)
    """)


def test_missing_candidate_does_not_fallback_to_enemy_direction(combat):
    combat.execute("""
        ctx.run={blackboard={plan={}}};ctx.params.directionPath='plan.direction'
        assert(input(ctx)=='failed' and result.reason=='direction_unavailable')
        assert(#calls==0 and #moves==0)
    """)


def test_candidate_is_transformed_to_camera_coordinates(combat):
    combat.execute("""
        CS.XRLManager.Camera.GetEulerY=function() return 90 end
        ctx.run={blackboard={plan={direction={x=1,y=0}}}}
        ctx.params.directionPath='plan.direction'
        assert(input(ctx)=='running')
        assert(math.abs(moves[1].x)<.000001 and math.abs(moves[1].y-1)<.000001)
        ctx.memory.cleanup();assert(moves[#moves].power==0 and #calls==0)
    """)
