"""真实 Lua 移动进展：受阻退出、逻辑帧门禁和本树输入清理。"""
from test_behavior_tree_combat import combat
from tools.gm_console.behavior_tree import validate_tree


def test_motionless_move_fails_and_releases_owned_input(combat):
    combat.execute("""
        player.CanMove=function() return true end
        assert(approach(ctx)=='running')
        for frame=2,10 do fight.Frame=frame;assert(approach(ctx)=='running') end
        fight.Frame=11;assert(approach(ctx)=='failed')
        assert(result.reason=='no_movement' and result.progressFrames==10)
        assert(result.canMoveKnown and result.canMove and result.displacement==0)
        assert(result.retryAfterFrame==21 and moves[#moves].power==0)
        assert(ctx.memory.cleanup==nil and #calls==0)
    """)


def test_blocked_node_reentry_keeps_retry_gate_without_holding_movement(combat):
    combat.execute("""
        player.CanMove=function() return true end
        approach(ctx)
        for frame=2,10 do fight.Frame=frame;assert(approach(ctx)=='running') end
        fight.Frame=11;assert(approach(ctx)=='failed')
        local count=#moves
        ctx.memory={};fight.Frame=12;assert(approach(ctx)=='failed')
        assert(result.reason=='blocked_retry' and #moves==count)
        fight.Frame=21;assert(approach(ctx)=='running')
        assert(result.progressFrames==0 and moves[#moves].power==1)
    """)


def test_progress_and_same_logic_frame_do_not_trip_stuck_detection(combat):
    combat.execute("""
        player.CanMove=function() return true end
        approach(ctx)
        for i=1,30 do ctx.now=i/100;assert(approach(ctx)=='running') end
        assert(result.progressFrames==0)
        fight.Frame=8;player.Position.x=0.3;assert(approach(ctx)=='running')
        fight.Frame=15;player.Position.x=0.6;assert(approach(ctx)=='running')
        fight.Frame=22;player.Position.x=0.9;assert(approach(ctx)=='running')
        assert(result.progressFrames==0)
    """)


def test_skill_lock_is_not_reported_as_a_wall(combat):
    combat.execute("""
        player.CanMove=function() return false end
        for frame=1,30 do fight.Frame=frame;assert(approach(ctx)=='running') end
        assert(result.canMoveKnown and not result.canMove and result.progressFrames==0)
        player.CanMove=function() return true end
        fight.Frame=31;assert(approach(ctx)=='running')
        fight.Frame=32;assert(approach(ctx)=='running')
        assert(result.progressFrames==1)
    """)


def test_unknown_move_gate_and_different_node_do_not_inherit_blocked_result(combat):
    combat.execute("""
        for frame=1,20 do fight.Frame=frame;assert(approach(ctx)=='running') end
        assert(not result.canMoveKnown and result.reason==nil)
        player.CanMove=function() return true end
        for frame=21,30 do fight.Frame=frame;assert(approach(ctx)=='running') end
        fight.Frame=31;assert(approach(ctx)=='failed')
        local previous=ctx.params
        ctx.params={role='player',output='other',distance=3,timeout=2}
        ctx.memory={};assert(approach(ctx)=='running')
        ctx.params=previous;ctx.memory={};assert(approach(ctx)=='failed')
        assert(result.reason=='blocked_retry')
    """)


def test_movement_catalog_accepts_explicit_progress_limits():
    tree = {
        'schemaVersion': 1, 'id': 'movement', 'root': 'move',
        'blackboard': {}, 'roles': {'player': {'kind': 'fight'}},
        'nodes': [{'id': 'move', 'type': 'fight_approach', 'version': 1, 'children': [],
                   'params': {'role': 'player', 'output': 'movement', 'distance': 5, 'timeout': 2,
                              'stuckFrames': 8, 'minProgress': .15, 'blockedRetryFrames': 12}}],
    }
    assert validate_tree(tree)['ok']
    tree['nodes'][0]['params']['stuckFrames'] = 0
    assert not validate_tree(tree)['ok']
