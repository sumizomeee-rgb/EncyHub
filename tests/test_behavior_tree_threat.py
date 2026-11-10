"""有限威胁规划的几何反例；不把离线候选当作实机无伤证据。"""
from pathlib import Path

import pytest

from test_behavior_tree_combat import combat


@pytest.fixture
def planner(combat):
    source = Path(__file__).parents[1] / 'tools/gm_console/behavior_tree_nodes/fight_threat.lua'
    combat.execute('BehaviorTreeHandlers={}\n' + source.read_text(encoding='utf-8'))
    combat.execute('''
        plan=BehaviorTreeHandlers.fight_plan
        missiles={};queryCount=0
        CS.Mathematics={fix2=function() return {} end};FixParse=function(v) return tonumber(v) end
        fight.Scene={ActiveTerrain={ThreeDMap=false},NavMesh={GetCell=function(_,p) return p end,
            CheckCellObstacle=function(_,p) queryCount=queryCount+1;return false end}}
        fight.MissileManager={GetMissileTable=function() return {GetEnumerator=function()
            local it={};local i=0
            function it:MoveNext() i=i+1;self.Current=missiles[i];return self.Current~=nil end
            return it
        end} end}
        enemy.TimeComponent={TimeScale=1}
        ctx.run={combat={target=enemy},blackboard={combat={frame=1,playerPosition={x=0,y=0},enemyExists=true,
            enemy={id=3,skillId=0,skillFrame=0,distance=10,position={x=10,y=0},facing={x=-1,y=0}},
            controlKnown=true,controlLocked=false,canMove=true,
            invincibleKnown=true,invincible=false,immuneDamageKnown=true,immuneDamage=false}}}
        ctx.params={role='player',observePath='combat',output='plan',horizonFrames=14,reactionFrames=2,
            desiredDistance=3,profile={fps=20,playerRadius=.5,walkSpeed=6,skills={},missiles={}}}
        ctx.write=function(key,value) ctx.run.blackboard[key]=value;result=value end
        function nextFrame(n)
            fight.Frame=n or fight.Frame+1;ctx.run.blackboard.combat.frame=fight.Frame
        end
        function addMissile(model,x,y,fx,fy,age)
            ctx.params.profile.missiles[#ctx.params.profile.missiles+1]=model
            local m={Id=#missiles+1,Template={Id=model.id},Npc=enemy,Alive=true,Removed=false,
                Position={x=x,y=y},Facing={x=fx,y=fy},CurrentMissileFrame=age or 0,
                SizeX=model.sizeX,SizeY=model.sizeY,Speed=model.speed or 0,TimeComponent={TimeScale=1}}
            missiles[#missiles+1]=m;return m
        end
        function enableDodge()
            player.TimeComponent={TimeScale=1};ctx.run.blackboard.combat.dodgeEnergyRatio=1
            ctx.params.profile.dodge={distanceMin=4.5,distanceMax=5.6,lateralMargin=.85,
                settleFrames=9,recoveryFrame=9,horizonFrames=30,inputDelayFrames=1,
                costRatio=.25,reserveRatio=.25,motionVerified=false,protectionVerified=false}
        end
    ''')
    return combat


def test_known_idle_allows_attack_without_inventing_danger(planner):
    planner.execute("assert(plan(ctx)=='succeeded');assert(result.known and result.safeToAttack and not result.needDodge and result.reason=='adjust_distance')")


def test_rectangle_uses_full_width_not_radius_and_actual_offset_position(planner):
    planner.execute('''
        addMissile({id=10,shape='rect',sizeX=4,sizeY=4,offsetY=100,lifeFrames=2},0,3,0,1)
        plan(ctx);assert(not result.currentDanger)
        missiles[1].Position.y=2.4;nextFrame();plan(ctx);assert(result.currentDanger)
        missiles[1].Position.x=2.4;missiles[1].Position.y=2.4;nextFrame();plan(ctx)
        assert(not result.currentDanger) -- 圆角膨胀，不能把两个轴都直接加半径。
    ''')


def test_consumed_nonrepeat_missile_body_does_not_spend_another_dodge(planner):
    planner.execute('''
        local m=addMissile({id=10,shape='circle',sizeX=2,lifeFrames=10},0,0,1,0)
        m.Template.RepeatDamage=false
        m.HitNpcSet={Contains=function(_,id) return id==player.Id end}
        plan(ctx);assert(result.known and not result.currentDanger and not result.needDodge)
        assert(result.threatCount==0 and result.safeToAttack)
    ''')


@pytest.mark.parametrize('state', ['repeat_true', 'repeat_unknown', 'hit_unknown'])
def test_repeat_or_unknown_consumption_keeps_actual_body_threat(planner, state):
    planner.execute('''
        live=addMissile({id=10,shape='circle',sizeX=2,lifeFrames=10},0,0,1,0)
        live.Template.RepeatDamage=false
        live.HitNpcSet={Contains=function() return true end}
    ''')
    planner.execute({
        'repeat_true': 'live.Template.RepeatDamage=true',
        'repeat_unknown': 'live.Template.RepeatDamage=nil',
        'hit_unknown': "live.HitNpcSet.Contains=function() error('unreadable') end",
    }[state])
    planner.execute('plan(ctx);assert(result.currentDanger and result.needDodge and not result.safeToAttack)')


def test_consumed_parent_body_keeps_delayed_child_threat(planner):
    planner.execute('''
        ctx.params.profile.missiles={{id=11,shape='circle',sizeX=2,lifeFrames=2,born='parent',direction='parent'}}
        local m=addMissile({id=10,shape='circle',sizeX=2,lifeFrames=40,
            children={{delayFrames=3,missileId=11}}},0,0,1,0)
        m.Template.RepeatDamage=false;m.HitNpcSet={Contains=function() return true end}
        plan(ctx);assert(not result.currentDanger and result.predictedDanger and result.needDodge)
        assert(result.threatCount==1 and result.hazards[1].source=='child')
    ''')


def test_consumed_old_body_does_not_remove_future_cast(planner):
    planner.execute('''
        local m=addMissile({id=10,shape='circle',sizeX=2,lifeFrames=10},0,0,1,0)
        m.Template.RepeatDamage=false;m.HitNpcSet={Contains=function() return true end}
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=1,position={x=1,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=3,missileId=10}}}}
        plan(ctx);assert(result.predictedDanger and result.needDodge and result.threatCount==1)
        assert(result.hazards[1].source=='skill')
    ''')


def test_far_boss_delayed_child_uses_real_parent_anchor(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy.distance=20
        ctx.run.blackboard.combat.enemy.position={x=20,y=0}
        ctx.params.profile.missiles={{id=11,shape='rect',sizeX=3.4,sizeY=7,offsetY=-1,lifeFrames=2,born='parent',direction='parent'}}
        addMissile({id=10,shape='none',sizeX=.1,lifeFrames=40,children={{delayFrames=11,missileId=11}}},0,1,0,1,9)
        plan(ctx);assert(result.known and result.predictedDanger and result.needDodge)
        assert(result.hazards[1].source=='child' and result.hazards[1].position.y==1)
    ''')


def test_walkable_escape_preserves_dodge_resource(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=10,missileId=10}}}}
        ctx.params.profile.missiles={{id=10,shape='rect',sizeX=1,sizeY=4,offsetY=2,lifeFrames=1}}
        plan(ctx);assert(result.predictedDanger and result.safeCandidateCount>0)
        assert(result.needMove and not result.needDodge and result.reason=='walk_clear')
    ''')


def test_future_unavoidable_attack_waits_for_protection_timing(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=11,missileId=10}}}}
        ctx.params.profile.missiles={{id=10,shape='circle',sizeX=20,lifeFrames=1}}
        plan(ctx);assert(result.predictedDanger and result.safeCandidateCount==0 and not result.needDodge)
        nextFrame();ctx.run.blackboard.combat.enemy.skillFrame=7;plan(ctx);assert(result.needDodge)
    ''')


def test_slowed_enemy_skill_frames_are_not_global_fight_frames(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=8,missileId=10}}}}
        ctx.params.profile.missiles={{id=10,shape='circle',sizeX=5,lifeFrames=1}}
        enemy.TimeComponent.TimeScale=.1
        plan(ctx);assert(result.enemyTimeScaleKnown and result.enemyTimeScale==.1)
        assert(result.known and not result.predictedDanger and result.safeToAttack)
        nextFrame();enemy.TimeComponent.TimeScale=1;plan(ctx);assert(result.predictedDanger)
    ''')


def test_frozen_enemy_does_not_hide_existing_actual_missile(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=8,missileId=10}}}}
        local m=addMissile({id=10,shape='circle',sizeX=2,lifeFrames=1},0,0,1,0)
        enemy.TimeComponent.TimeScale=0
        plan(ctx);assert(result.currentDanger and not result.safeToAttack)
        nextFrame();m.TimeComponent.TimeScale=0;plan(ctx)
        assert(result.currentDanger and not result.safeToAttack) -- 已有判定保守保留，不把超算一律当安全。
    ''')


def test_parent_child_delay_uses_parent_time_scale(planner):
    planner.execute('''
        ctx.params.profile.missiles={{id=11,shape='rect',sizeX=3.4,sizeY=7,lifeFrames=2,born='parent',direction='parent'}}
        local m=addMissile({id=10,shape='none',lifeFrames=40,children={{delayFrames=11,missileId=11}}},0,1,0,1,9)
        m.TimeComponent.TimeScale=.1;plan(ctx);assert(result.known and not result.predictedDanger)
        nextFrame();m.TimeComponent.TimeScale=1;plan(ctx);assert(result.predictedDanger)
    ''')


def test_unreadable_time_scale_cannot_become_a_safe_output_window(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=8,missileId=10}}}}
        ctx.params.profile.missiles={{id=10,shape='circle',sizeX=5,lifeFrames=1}}
        enemy.TimeComponent=nil;plan(ctx);assert(not result.enemyTimeScaleKnown and not result.safeToAttack)
        nextFrame();enemy.TimeComponent={TimeScale=1}
        local m=addMissile({id=11,shape='circle',sizeX=2,lifeFrames=2},0,0,1,0)
        m.TimeComponent=nil;plan(ctx);assert(not result.missileTimeScalesKnown and not result.safeToAttack)
    ''')


def test_expired_cast_is_not_resurrected_when_slowdown_ends(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=16,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=13,missileId=10,spawnDelayFrames=1}}}}
        ctx.params.profile.missiles={{id=10,shape='circle',sizeX=20,lifeFrames=2}}
        enemy.TimeComponent.TimeScale=.2
        plan(ctx);assert(not result.predictedDanger and not result.needDodge)
        nextFrame();enemy.TimeComponent.TimeScale=1;ctx.run.blackboard.combat.enemy.skillFrame=17
        plan(ctx);assert(result.known and result.threatCount==0 and not result.currentDanger and not result.needDodge)
        -- 已过去的Cast不重建；仍真实存在的弹道继续读，不能一并删除。
        nextFrame();addMissile({id=10,shape='circle',sizeX=20,lifeFrames=2},0,0,1,0,1)
        plan(ctx);assert(result.currentDanger and result.needDodge)
    ''')


@pytest.mark.parametrize('source', ['cast', 'child'])
def test_reaction_padding_does_not_advance_projectile_motion(planner, source):
    planner.execute("ctx.params.profile.missiles={{id=11,shape='circle',sizeX=.1,lifeFrames=10,speed=20,lineType=1,born='parent',direction='parent'}}")
    planner.execute({
        'cast': '''
            ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=5,position={x=5,y=0},facing={x=-1,y=0}}
            ctx.params.profile.skills={{id=7,casts={{frame=5,missileId=11}}}}
            ctx.params.profile.missiles[1].born='launcher'
        ''',
        'child': "addMissile({id=10,shape='none',lifeFrames=40,children={{delayFrames=5,missileId=11}}},5,0,-1,0)",
    }[source])
    planner.execute('''
        plan(ctx);assert(result.known and result.predictedDanger)
        assert(result.earliestImpactFrames==10) -- t=5才出生；不能把提前2帧警戒当成已飞行2m。
    ''')


@pytest.mark.parametrize('source', ['cast', 'child'])
@pytest.mark.parametrize('life', ['nil', '0', '-1', 'math.huge'])
def test_missing_or_invalid_future_damage_lifetime_is_unknown(planner, source, life):
    planner.execute(f"ctx.params.profile.missiles={{{{id=11,shape='circle',sizeX=5,lifeFrames={life},born='parent',direction='parent'}}}}")
    planner.execute({
        'cast': '''
            ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
            ctx.params.profile.skills={{id=7,casts={{frame=3,missileId=11}}}}
            ctx.params.profile.missiles[1].born='launcher'
        ''',
        'child': "addMissile({id=10,shape='none',lifeFrames=40,children={{delayFrames=3,missileId=11}}},0,0,1,0)",
    }[source])
    planner.execute("plan(ctx);assert(not result.modelKnown and not result.known and not result.safeToAttack)")


@pytest.mark.parametrize('unknown', ['missiles', 'skill', 'body'])
def test_unknown_is_not_safety(planner, unknown):
    planner.execute({
        'missiles': "fight.MissileManager=nil",
        'skill': "ctx.run.blackboard.combat.enemy.skillId=999",
        'body': "ctx.params.profile.playerRadius=nil",
    }[unknown])
    planner.execute("plan(ctx);assert(not result.known and not result.safeToAttack and result.defending and not result.needDodge)")


def test_unknown_protection_or_control_does_not_claim_dodge_can_execute(planner):
    planner.execute('''
        addMissile({id=10,shape='circle',sizeX=2,lifeFrames=2},0,0,1,0)
        ctx.run.blackboard.combat.invincibleKnown=false
        plan(ctx);assert(result.currentDanger and not result.needDodge and not result.protectionKnown)
        nextFrame();ctx.run.blackboard.combat.invincibleKnown=true;ctx.run.blackboard.combat.controlKnown=false
        plan(ctx);assert(not result.needDodge and not result.safeToAttack and not result.controlKnown)
    ''')


def test_actual_protection_prevents_duplicate_dodge(planner):
    planner.execute('''
        addMissile({id=10,shape='circle',sizeX=2,lifeFrames=2},0,0,1,0)
        ctx.run.blackboard.combat.invincible=true
        plan(ctx);assert(result.protected and result.protectionKnown and not result.needDodge)
        assert(result.needMove and result.reason=='protected_reposition')
    ''')


def test_repeated_turn_changes_future_attack_facing(planner):
    planner.execute('''
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=1,y=0}}
        ctx.params.profile.skills={{id=7,turns={{frame=0,durationFrames=8}},casts={{frame=9,missileId=10}}}}
        ctx.params.profile.missiles={{id=10,shape='rect',sizeX=2,sizeY=4,offsetY=2,lifeFrames=1}}
        plan(ctx);assert(result.predictedDanger) -- 当前朝向背对玩家，后续Turn重新追踪。
        nextFrame();ctx.params.profile.skills[1].turns={};plan(ctx);assert(not result.predictedDanger)
    ''')


@pytest.mark.parametrize('skill_frame,player_pos,boss_pos,next_pos,earliest,needs_dodge', [
    (12, (32.4927069333, 353.3518531439), (33.0017763036, 345.8655936392),
     (32.8955954483, 347.66145913), 8, False),
    (13, (32.4213837706, 353.586972768), (32.8955954483, 347.66145913),
     (32.7627911833, 349.6144487502), 7, True),
])
def test_recorded_late_dash_uses_only_one_frame_pending_anchor(
    planner, skill_frame, player_pos, boss_pos, next_pos, earliest, needs_dodge
):
    # 5223/5224原观测；pending是next实际位置的显式反事实绑定，由独立701帧对验证契约。
    planner.execute(f'''
        ctx.params.profile.playerRadius=.4;ctx.params.profile.walkSpeed=4.98
        ctx.run.blackboard.combat.playerPosition={{x={player_pos[0]},y={player_pos[1]}}}
        ctx.run.blackboard.combat.enemy={{id=3,skillId=7,skillFrame={skill_frame},distance=6,
            position={{x={boss_pos[0]},y={boss_pos[1]}}},facing={{x=-.05,y=.998}}}}
        ctx.params.profile.skills={{{{id=7,turns={{{{frame=0,durationFrames=13}},{{frame=13,durationFrames=8}}}},
            moves={{{{frame=8,durationFrames=5,speed=30}},{{frame=16,durationFrames=5,speed=30}}}},
            casts={{{{frame=13,missileId=10,spawnDelayFrames=1}},{{frame=21,missileId=10,spawnDelayFrames=1}}}}}}}}
        ctx.params.profile.missiles={{{{id=10,shape='rect',sizeX=4,sizeY=5,offsetY=2.5,lifeFrames=2,
            born='launcher',direction='launcher'}}}}
        plan(ctx);assert(not result.needDodge and result.earliestImpactFrames=={earliest})
        nextFrame();ctx.params.profile.usePendingEnemyAnchor=true
        enemy.MoveComponent={{ToPosition={{x={next_pos[0]},y={next_pos[1]}}}}}
        plan(ctx);assert(result.known and result.needDodge=={str(needs_dodge).lower()})
    ''')
    if needs_dodge:
        planner.execute('assert(result.pendingEnemyAnchorKnown and result.earliestImpactFrames==0)')
    else:
        planner.execute('assert(result.pendingEnemyAnchorKnown==nil and result.earliestImpactFrames==8)')


def test_enabled_pending_anchor_without_binding_cannot_claim_known_safety(planner):
    planner.execute('''
        ctx.params.profile.usePendingEnemyAnchor=true
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=13,distance=6,
            position={x=6,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=13,missileId=10,spawnDelayFrames=1}}}}
        ctx.params.profile.missiles={{id=10,shape='rect',sizeX=4,sizeY=5,offsetY=2.5,lifeFrames=2}}
        enemy.MoveComponent=nil;plan(ctx)
        assert(result.pendingEnemyAnchorKnown==false and not result.known and not result.safeToAttack)
    ''')


def test_blocked_terrain_has_no_fabricated_goal(planner):
    planner.execute('''
        fight.Scene.NavMesh.CheckCellObstacle=function() return true end
        plan(ctx);assert(result.pathKnown and result.goal==nil and result.needMove)
        nextFrame();fight.Scene=nil;plan(ctx)
        assert(not result.pathKnown and result.pathReason=='terrain_query_unknown' and result.goal==nil and result.needMove)
    ''')


def test_known_safe_position_does_not_approach_through_known_danger(planner):
    planner.execute('''
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=20},3,0,1,0)
        fight.Scene.NavMesh.CheckCellObstacle=function(_,p) return p.x<-.6 or math.abs(p.y)>.6 end
        plan(ctx);assert(not result.predictedDanger and result.needMove)
        assert(result.candidateRisk>0 and result.goal==nil and not result.directionKnown)
    ''')


def test_unknown_or_3d_map_and_non_boolean_query_are_not_walkable(planner):
    planner.execute('''
        fight.Scene.ActiveTerrain.ThreeDMap=nil;plan(ctx);assert(not result.pathKnown and result.goal==nil)
        nextFrame();fight.Scene.ActiveTerrain.ThreeDMap=true;plan(ctx);assert(not result.pathKnown and result.goal==nil)
        nextFrame();fight.Scene.ActiveTerrain.ThreeDMap=false
        fight.Scene.NavMesh.CheckCellObstacle=function() return nil end
        plan(ctx);assert(not result.pathKnown and result.goal==nil)
    ''')


def test_failed_direction_is_excluded_for_ttl(planner):
    planner.execute('''
        ctx.run.navigationFailures={{frame=1,direction={x=1,y=0},goal={x=3,y=0},reason='no_movement'}}
        plan(ctx);assert(result.direction and result.direction.x<.99)
        nextFrame(42);plan(ctx);assert(result.direction.x>.99)
    ''')


def test_business_distance_override_is_bounded_and_optional(planner):
    planner.execute('''
        ctx.params.desiredDistancePath='tactics.distance';ctx.run.blackboard.tactics={distance=9}
        plan(ctx);assert(result.desiredDistance==9)
        nextFrame();ctx.run.blackboard.tactics.distance=math.huge;plan(ctx);assert(result.desiredDistance==3)
        nextFrame();ctx.run.blackboard.tactics.distance=2.5;plan(ctx);assert(result.desiredDistance==2.5)
    ''')


def test_equal_risk_small_score_change_does_not_flip_goal_each_frame(planner):
    planner.execute('''
        ctx.params.desiredDistance=2.5
        ctx.run.blackboard.combat.enemy.position={x=3.4,y=0};ctx.run.blackboard.combat.enemy.distance=3.4
        plan(ctx);local goal=result.goal;assert(math.abs(goal.y)>1)
        nextFrame();ctx.run.blackboard.combat.enemy.position.y=goal.y>0 and .02 or -.02
        plan(ctx);assert(result.goal.x==goal.x and result.goal.y==goal.y and result.goalSelection=='held_rechecked')
        assert(result.selectedAtFrame==1)
        ctx.run.threatPlans.plan.selectedGoal=nil;nextFrame();plan(ctx)
        assert(math.abs(result.goal.x-goal.x)+math.abs(result.goal.y-goal.y)>.001)
    ''')


def test_goal_hysteresis_rechecks_danger_before_holding(planner):
    planner.execute('''
        ctx.params.desiredDistance=2.5
        ctx.run.blackboard.combat.enemy.position={x=3.4,y=0};ctx.run.blackboard.combat.enemy.distance=3.4
        plan(ctx);local goal=result.goal
        nextFrame();addMissile({id=10,shape='circle',sizeX=.9,lifeFrames=20},goal.x,goal.y,1,0)
        plan(ctx);assert(result.goalSelection=='new' and result.goalSafe and result.goal.y*goal.y<0)
    ''')


@pytest.mark.parametrize('change', ['failed', 'arrived', 'intent', 'terrain'])
def test_goal_hysteresis_yields_to_failure_arrival_intent_and_terrain(planner, change):
    planner.execute('''
        ctx.params.desiredDistance=2.5
        ctx.run.blackboard.combat.enemy.position={x=3.4,y=0};ctx.run.blackboard.combat.enemy.distance=3.4
        plan(ctx);oldGoal=result.goal;assert(math.abs(oldGoal.y)>1)
        nextFrame()
    ''')
    planner.execute({
        'failed': "ctx.run.navigationFailures={{frame=1,goal=oldGoal,reason='terrain_blocked'}}",
        'arrived': "ctx.run.blackboard.combat.playerPosition=oldGoal;ctx.run.blackboard.combat.enemy.distance=2.47",
        'intent': "ctx.params.desiredDistance=9",
        'terrain': "fight.Scene.NavMesh.CheckCellObstacle=function(_,p) return p.y*oldGoal.y>1 end",
    }[change])
    planner.execute("plan(ctx);assert(result.goalSelection~='held_rechecked')")


def test_one_logic_frame_is_only_planned_once(planner):
    planner.execute('''
        plan(ctx);local count=queryCount;assert(count>0)
        plan(ctx);assert(queryCount==count)
        nextFrame();plan(ctx);assert(queryCount>count)
    ''')


def test_attack_identity_changes_on_restart_not_every_update(planner):
    planner.execute('''
        ctx.params.profile.skills={{id=7,casts={}}};ctx.run.blackboard.combat.enemy.skillId=7
        ctx.run.blackboard.combat.enemy.skillFrame=5;plan(ctx);local first=result.attackIdentity
        nextFrame();ctx.run.blackboard.combat.enemy.skillFrame=6;plan(ctx);assert(result.attackIdentity==first)
        nextFrame();ctx.run.blackboard.combat.enemy.skillFrame=0;plan(ctx);assert(result.attackIdentity~=first)
    ''')


def test_dictionary_entry_and_bounded_missile_enumeration(planner):
    planner.execute('''
        local m=addMissile({id=10,shape='circle',sizeX=1,lifeFrames=10},10,0,1,0)
        missiles={{Value=m}};plan(ctx);assert(result.missilesKnown and result.known)
        for i=2,33 do missiles[i]={Value=m} end
        nextFrame();plan(ctx);assert(result.missilesKnown and result.missilesTruncated and not result.known)
    ''')


def test_known_harmless_effects_do_not_poison_model_or_relevant_missile_budget(planner):
    planner.execute('''
        local m=addMissile({id=10,shape='none',lifeFrames=10},10,0,0,0)
        m.Position=nil;m.Facing=nil;m.CurrentMissileFrame=nil
        for i=2,40 do missiles[i]=m end
        plan(ctx);assert(result.known and result.threatCount==0 and not result.missilesTruncated)
    ''')


def test_dodge_candidates_separate_from_walk_and_avoid_later_coverage(planner):
    planner.execute('''
        enableDodge()
        ctx.run.blackboard.combat.enemy={id=3,skillId=7,skillFrame=0,distance=3,position={x=3,y=0},facing={x=-1,y=0}}
        ctx.params.profile.skills={{id=7,casts={{frame=18,missileId=11}}}}
        ctx.params.profile.missiles={{id=11,shape='circle',sizeX=4,lifeFrames=2}}
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx)
        assert(result.direction.x>0 and result.dodge.direction.x<0)
        assert(result.dodge.followupThreats==0 and result.dodge.landingClearInModel)
        assert(result.dodge.postFromFrames==9) -- 起手已是Skill.RunFrame=1，9号帧是首个恢复评分帧。
        assert(not result.dodge.known and not result.dodge.landingSafe and result.dodge.recommended)
        assert(result.dodge.horizonFrames==30 and result.needDodge)
    ''')


def test_empirical_dodge_does_not_discount_unknown_protection_or_claim_safety(planner):
    planner.execute('''
        enableDodge();ctx.params.profile.dodge.protectionVerified=true
        addMissile({id=10,shape='circle',sizeX=2,lifeFrames=2},0,0,1,0)
        plan(ctx);assert(result.dodge.directionKnown and result.dodge.travelRisk>0)
        assert(not result.dodge.protectionDiscounted and not result.dodge.known and not result.dodge.landingSafe)
    ''')


def test_dodge_extent_checks_obstacle_beyond_short_walk_goal(planner):
    planner.execute('''
        enableDodge();addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        fight.Scene.NavMesh.CheckCellObstacle=function(_,p) return p.x>4.8 end
        plan(ctx);assert(result.direction.x>.9 and result.goal.x<4.8)
        assert(result.dodge.directionKnown and result.dodge.direction.x<.8)
    ''')


def test_dodge_does_not_rank_a_path_through_current_target_body(planner):
    planner.execute('''
        enableDodge()
        ctx.run.blackboard.combat.enemy.position={x=1.65,y=0}
        ctx.run.blackboard.combat.enemy.distance=1.65
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx);assert(result.dodge.direction.x>.99) -- 未指定目标体积时保留原契约。
        nextFrame();ctx.params.profile.dodge.avoidTargetRadius=1.4
        plan(ctx);assert(result.dodge.directionKnown and math.abs(result.dodge.direction.x)<.01)
        assert(result.needDodge and result.dodge.canAfford)
        assert(not result.dodge.known and not result.dodge.landingSafe)
    ''')


def test_dodge_inside_target_circle_can_still_retreat(planner):
    planner.execute('''
        enableDodge();ctx.params.profile.dodge.avoidTargetRadius=1.4
        ctx.run.blackboard.combat.enemy.position={x=1,y=0}
        ctx.run.blackboard.combat.enemy.distance=1
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx);assert(result.dodge.directionKnown and math.abs(result.dodge.direction.x)<.01)
        nextFrame();fight.Scene.NavMesh.CheckCellObstacle=function(_,p) return p.x>.3 end
        plan(ctx);assert(result.dodge.directionKnown and result.dodge.direction.x<-.99)
    ''')


def test_dodge_target_filter_checks_finite_segment_not_infinite_ray(planner):
    planner.execute('''
        enableDodge();ctx.params.profile.dodge.avoidTargetRadius=1.4
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx);assert(result.dodge.directionKnown and result.dodge.direction.x>.99)
        assert(result.dodge.goal.x<ctx.run.blackboard.combat.enemy.position.x-1.4)
    ''')


def test_dodge_resource_budget_is_reported_without_inventing_reserve(planner):
    planner.execute('''
        enableDodge();ctx.run.blackboard.combat.dodgeEnergyRatio=.3
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx);assert(result.dodge.canAfford and result.dodge.budgetTight and result.dodge.recommended)
        assert(math.abs(result.dodge.reserveAfter-.05)<.00001)
        nextFrame();ctx.run.blackboard.combat.dodgeEnergyRatio=.2;plan(ctx)
        assert(not result.dodge.canAfford and not result.dodge.recommended and result.dodge.directionKnown)
    ''')


def test_dodge_recovery_beyond_horizon_or_unknown_rate_is_not_safe(planner):
    planner.execute('''
        enableDodge();player.TimeComponent.TimeScale=.1
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx);assert(result.dodge.playerTimeScaleKnown and result.dodge.reason=='recovery_beyond_horizon')
        assert(not result.dodge.landingClearInModel and not result.dodge.known)
        nextFrame();player.TimeComponent=nil;plan(ctx)
        assert(not result.dodge.playerTimeScaleKnown and not result.dodge.known)
    ''')


def test_dodge_without_terrain_candidates_keeps_unknown_direction(planner):
    planner.execute('''
        enableDodge();fight.Scene.NavMesh.CheckCellObstacle=function() return true end
        addMissile({id=10,shape='circle',sizeX=1,lifeFrames=1},0,0,1,0)
        plan(ctx);assert(not result.dodge.directionKnown and not result.dodge.landingSafe)
        assert(result.dodge.reason=='no_terrain_candidate' and result.dodge.goal==nil)
    ''')


def test_no_imminent_dodge_skips_extra_candidates_and_terrain_queries(planner):
    planner.execute('''
        enableDodge();plan(ctx)
        assert(not result.needDodge and result.dodge.reason=='not_needed')
        assert(not result.dodge.directionKnown and queryCount==160)
    ''')
