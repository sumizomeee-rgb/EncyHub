"""卡穆预设依赖的通用观测和正常按键条件回归。"""
import json

import pytest

from test_behavior_tree_combat import combat


@pytest.fixture
def tactics(combat):
    combat.execute('''
        CS.XNpcAttribType.Energy=1;CS.XNpcAttribType.DodgeEnergy=2;CS.XNpcDodgeState={Activate=1};fight.Result={Data={MatrixTimes=0}}
        fight.BuffManager={ExistByKind=function(_,npc,kind) return npc.buffs and npc.buffs[kind]==true or false end}
        player.TemplateId=10210011;enemy.TemplateId=83101;enemy.Facing={x=-1,y=0}
        player.Attrib={[0]={Value=100},[1]={Value=100},[2]={Value=1000,MaxValue=1000}}
        fight.FightData={StageId=30300803}
        ctx.run={blackboard={}}
        ctx.params.stageId=30300803;ctx.params.playerTemplateIds={10210011,10210016};ctx.params.enemyTemplateId=83101
        ctx.write=function(key,value) ctx.run.blackboard[key]=value;result=value end
    ''')
    return combat



def test_optional_attributes_keep_zero_and_default_empty_object(tactics):
    tactics.execute("""
        local reads=0
        setmetatable(player.Attrib,{__index=function() reads=reads+1;error('unexpected read') end})
        observe(ctx);assert(reads==0 and next(result.playerAttributes)==nil)
        player.Attrib[75]={Value=0,MaxValue=0};ctx.params.playerAttributeIds={75}
        observe(ctx)
        assert(result.playerAttributes['75'].known and result.playerAttributes['75'].value==0)
        assert(result.playerAttributes['75'].maxKnown and result.playerAttributes['75'].max==0)
    """)
    tactics.execute('ctx.params.playerAttributeIds=nil;observe(ctx)')
    assert json.loads(tactics.globals().encodeResult())['playerAttributes'] == {}


@pytest.mark.parametrize('field', ['Value', 'MaxValue'])
@pytest.mark.parametrize('failure', ['missing', 'throws', 'nan', 'infinite'])
def test_optional_attribute_fields_fail_independently(tactics, field, failure):
    tactics.execute("ctx.params.playerAttributeIds={75};player.Attrib[75]={Value=12,MaxValue=20}")
    tactics.execute({
        'missing': f"player.Attrib[75].{field}=nil",
        'throws': f"player.Attrib[75].{field}=nil;setmetatable(player.Attrib[75],{{__index=function() error('unreadable') end}})",
        'nan': f"player.Attrib[75].{field}=0/0",
        'infinite': f"player.Attrib[75].{field}=math.huge",
    }[failure])
    tactics.execute("assert(observe(ctx)=='succeeded')")
    item = json.loads(tactics.globals().encodeResult())['playerAttributes']['75']
    if field == 'Value':
        assert item == {'known': False, 'maxKnown': True, 'max': 20}
    else:
        assert item == {'known': True, 'value': 12, 'maxKnown': False}


def test_optional_attribute_index_failure_and_snapshot_isolation(tactics):
    tactics.execute("""
        ctx.params.playerAttributeIds={75,76}
        player.Attrib[75]={Value=4,MaxValue=10}
        setmetatable(player.Attrib,{__index=function() error('attribute unavailable') end})
        observe(ctx);local previous=result
        assert(not previous.playerAttributes['76'].known and not previous.playerAttributes['76'].maxKnown)
        player.Attrib[75].Value=7;ctx.params.playerAttributeIds={75};observe(ctx)
        assert(result.playerAttributes['75'].value==7 and previous.playerAttributes['75'].value==4)
        assert(result.playerAttributes['76']==nil and previous.playerAttributes['76']~=nil)
    """)


@pytest.mark.parametrize('ids', [
    'false', '75', "'75'", '{75.5}', '{-1}', '{2147483648}', '{0/0}', '{math.huge}',
    '{true}', "{'75'}", '{[2]=75}', '{key=75}',
    '(function() observe(ctx);return setmetatable({},getmetatable(result.playerAttributes)) end)()', '{' + ','.join(['75']*17) + '}',
])
def test_optional_attribute_parameter_is_bounded_before_reading(tactics, ids):
    tactics.execute(f"ctx.params.playerAttributeIds={ids}")
    tactics.execute("""
        ctx.object=function() error('must reject before object access') end
        assert(observe(ctx)=='failed' and result.error=='invalid_player_attribute_ids')
    """)


def test_optional_attribute_boundary_and_catalog_parameter(tactics):
    from tools.gm_console.behavior_tree import node_catalog, validate_tree

    definition = next(item for item in node_catalog() if item['id'] == 'fight_observe')
    assert definition['params']['properties']['playerAttributeIds']['default'] == []
    tree = {'schemaVersion': 1, 'id': 'attribute-observation', 'root': 'observe',
            'roles': {'fight': {'kind': 'fight'}}, 'nodes': [
                {'id': 'observe', 'type': 'fight_observe', 'version': 1, 'children': [],
                 'params': {'role': 'fight', 'output': 'combat', 'playerAttributeIds': [75,76,77,78]}}]}
    assert validate_tree(tree)['ok']
    tactics.execute("""
        ctx.params.playerAttributeIds={0,2147483647};observe(ctx)
        assert(result.playerAttributes['0'].known and result.playerAttributes['0'].value==100)
        assert(not result.playerAttributes['2147483647'].known)
        ctx.params.playerAttributeIds={1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16}
        assert(observe(ctx)=='succeeded' and result.playerAttributes['16']~=nil)
    """)


def test_observation_rejects_wrong_stage_and_player(tactics):
    tactics.execute("ctx.params.stageId=1;assert(observe(ctx)=='failed' and result.error=='stage_mismatch')")
    tactics.execute("ctx.params.stageId=30300803;player.TemplateId=1;assert(observe(ctx)=='failed' and result.error=='player_mismatch')")


def test_observation_recent_skill_uses_real_start_not_press(tactics):
    tactics.execute("player.SkillGroupComponent.CurrentSkill={Id=100203,RunFrame=0};assert(observe(ctx)=='succeeded')")
    tactics.execute("ctx.params.skillIds={100203};ctx.params.seconds=4;ctx.now=3;player.SkillGroupComponent.CurrentSkill.RunFrame=90;observe(ctx);assert(recent(ctx)=='succeeded')")
    tactics.execute("ctx.now=4.1;observe(ctx);assert(recent(ctx)=='failed')")


def test_skill_object_reuse_records_restart(tactics):
    tactics.execute("player.SkillGroupComponent.CurrentSkill={Id=100203,RunFrame=10};observe(ctx)")
    tactics.execute("ctx.now=5;player.SkillGroupComponent.CurrentSkill.RunFrame=0;observe(ctx);ctx.params.skillIds={100203};ctx.params.seconds=1;assert(recent(ctx)=='succeeded')")


def test_enemy_window_checks_id_frame_and_distance(tactics):
    tactics.execute("enemy.SkillGroupComponent={CurrentSkill={Id=831005,RunFrame=8}};observe(ctx);ctx.params.windows={{skillId=831005,fromFrame=4,toFrame=10,distance=12}};assert(enemyWindow(ctx)=='succeeded')")
    tactics.execute("ctx.params.windows[1].distance=7;assert(enemyWindow(ctx)=='failed')")
    tactics.execute("ctx.params.windows[1].distance=12;enemy.SkillGroupComponent.CurrentSkill.RunFrame=11;observe(ctx);assert(enemyWindow(ctx)=='failed')")


def test_boss_death_is_observed_without_selecting_other_npc(tactics):
    tactics.execute("""
        observe(ctx);enemy.IsDead=true;enemy.Attrib[0].Value=0
        assert(observe(ctx)=='succeeded' and result.finished and not result.enemyExists)
        assert(result.targetLifeKnown and result.targetLife==0 and result.finishReason=='target_killed')
    """)


def test_initial_target_not_observed_can_be_discovered_later(tactics):
    tactics.execute("""
        enemy.IsActivate=false
        assert(observe(ctx)=='succeeded' and not result.finished and not result.enemyExists)
        assert(result.finishReason=='target_not_observed' and not result.targetLifeKnown)
        assert(ctx.run.combat.target==nil)
        fight.Frame=fight.Frame+1;enemy.IsActivate=true
        assert(observe(ctx)=='succeeded' and not result.finished and result.enemyExists)
        assert(result.finishReason=='target_active' and result.targetLifeKnown and result.targetLife==100)
        assert(ctx.run.combat.target==enemy)
    """)


def test_cleanup_dead_with_positive_life_is_not_a_kill(tactics):
    tactics.execute("""
        observe(ctx);enemy.IsDead=true
        assert(observe(ctx)=='failed' and not result.finished and not result.enemyExists)
        assert(result.targetLifeKnown and result.targetLife==100 and result.finishReason=='target_dead_with_life')
    """)


@pytest.mark.parametrize('invalid', ['deleted', 'life_unreadable', 'life_nan', 'life_infinite'])
def test_invalid_cached_target_never_reports_a_kill(tactics, invalid):
    tactics.execute('observe(ctx);enemy.IsDead=true')
    tactics.execute({
        'deleted': 'enemy.IsDeleted=true;enemy.Attrib=nil',
        'life_unreadable': 'enemy.Attrib=nil',
        'life_nan': 'enemy.Attrib[0].Value=0/0',
        'life_infinite': 'enemy.Attrib[0].Value=math.huge',
    }[invalid])
    tactics.execute("assert(observe(ctx)=='failed' and not result.finished and not result.targetLifeKnown)")
    expected = 'target_deleted' if invalid == 'deleted' else 'target_life_unknown'
    assert tactics.globals().result.finishReason == expected


def test_alive_target_reports_real_life_and_remains_observable(tactics):
    tactics.execute("""
        assert(observe(ctx)=='succeeded' and not result.finished and result.enemyExists)
        assert(result.targetLifeKnown and result.targetLife==100 and result.enemy.life==100)
        assert(result.finishReason=='target_active')
    """)


def test_target_disappearing_without_death_is_not_a_kill(tactics):
    tactics.execute("""
        observe(ctx);enemy.IsActivate=false
        assert(observe(ctx)=='failed' and not result.finished and result.finishReason=='target_unavailable')
    """)


def test_active_target_life_read_failure_is_diagnostic(tactics):
    tactics.execute("""
        observe(ctx);enemy.Attrib=nil
        assert(observe(ctx)=='failed' and not result.finished and not result.targetLifeKnown)
        assert(result.finishReason=='target_life_unknown')
    """)


def test_reserve_red_after_three_ping(tactics):
    tactics.execute('''
        local balls={{Key=2,IsReady=true,GroupItemCount=3},{Key=2,IsReady=true,GroupItemCount=3},
            {Key=2,IsReady=true,GroupItemCount=3},{Key=1,IsReady=true,GroupItemCount=1}}
        player.FightBallControl.GetFightContainerCount=function() return #balls end
        player.FightBallControl.GetFightBallContainerData=function(_,_,i) return balls[i+1] end
        ctx.params.minGroup=3;ctx.params.reserveColor=1
        assert(ballReady(ctx)=='succeeded');assert(input(ctx)=='running')
    ''')
    # 同时验证普攻原有路径未受球选择参数影响。
    assert tactics.globals().calls[1].key == 15


def test_all_red_three_ping_cannot_destroy_only_followup(tactics):
    tactics.execute('''
        player.FightBallControl.GetFightContainerCount=function() return 3 end
        player.FightBallControl.GetFightBallContainerData=function() return {Key=1,IsReady=true,GroupItemCount=3} end
        ctx.params.minGroup=3;ctx.params.reserveColor=1;assert(ballReady(ctx)=='failed')
    ''')


def test_input_cooldown_survives_node_memory_reset(tactics):
    tactics.execute("ctx.params.cooldownSeconds=0.5;assert(input(ctx)=='running');ctx.now=0.1;assert(input(ctx)=='succeeded');ctx.memory={};ctx.now=0.2;assert(input(ctx)=='failed' and #calls==2)")


def test_direction_is_prepared_before_key_down_and_released(tactics):
    tactics.execute("ctx.params.action='dodge';ctx.params.direction='left';assert(input(ctx)=='running' and #calls==0 and moves[1].y==1)")
    tactics.execute("ctx.now=0.04;assert(input(ctx)=='running' and #calls==1);ctx.now=0.2;assert(input(ctx)=='succeeded');assert(moves[#moves].power==0 and calls[#calls].kind==2)")


def test_preempted_direction_has_no_unsubmitted_key(tactics):
    tactics.execute("ctx.params.direction='left';assert(input(ctx)=='running');ctx.memory.cleanup();assert(#calls==0 and moves[#moves].power==0)")


@pytest.mark.parametrize('operator,value,expected', [('ge', 100, 'succeeded'), ('gt', 100, 'failed'), ('eq', 100, 'succeeded')])
def test_blackboard_path_compare(tactics, operator, value, expected):
    tactics.execute('observe(ctx)')
    ctx=tactics.globals().ctx
    ctx.params.path='result.energy'
    ctx.params.operator=operator
    ctx.params.value=value
    assert tactics.globals().compare(ctx)==expected


def test_dead_player_ends_observation(tactics):
    tactics.execute("player.IsDead=true;assert(observe(ctx)=='failed' and result.playerDead)")

def test_recent_skill_logic_frames_are_independent_of_wall_time(tactics):
    tactics.execute("fight.Frame=10;player.SkillGroupComponent.CurrentSkill={Id=100203,RunFrame=0};observe(ctx)")
    tactics.execute("fight.Frame=110;ctx.now=20;player.SkillGroupComponent.CurrentSkill.RunFrame=100;observe(ctx);ctx.params.skillIds={100203};ctx.params.frames=120;assert(recent(ctx)=='succeeded')")
    tactics.execute("fight.Frame=131;observe(ctx);assert(recent(ctx)=='failed')")

def test_retreat_uses_normal_movement_and_releases(tactics):
    tactics.execute("ctx.params.mode='retreat';ctx.params.distance=12;assert(approach(ctx)=='running' and moves[1].x==-1)")
    tactics.execute("enemy.Position.x=13;assert(approach(ctx)=='succeeded' and moves[#moves].power==0)")


def test_matrix_facts_require_real_counter_and_buffs(tactics):
    tactics.execute("fight.Result.Data.MatrixTimes=2;player.DodgeState=1;player.buffs={[1000720]=true};enemy.buffs={[1000680]=true};ctx.params.playerBuffKinds={1000720};ctx.params.enemyBuffKinds={1000680};observe(ctx);assert(result.matrixTimes==2 and result.matrixReady and result.playerBuffs['1000720'] and result.enemyBuffs['1000680'])")
    tactics.execute("player.buffs={};enemy.buffs={};observe(ctx);assert(not result.playerBuffs['1000720'] and not result.enemyBuffs['1000680'])")

def test_template_allowlist_accepts_quality_variant(tactics):
    tactics.execute("player.TemplateId=10210016;assert(observe(ctx)=='succeeded')")

def test_matrix_ping_can_choose_small_group_and_preserve_red(tactics):
    tactics.execute("local balls={{Key=3,IsReady=true,GroupItemCount=3},{Key=2,IsReady=true,GroupItemCount=1},{Key=1,IsReady=true,GroupItemCount=1}};player.FightBallControl.GetFightContainerCount=function() return #balls end;player.FightBallControl.GetFightBallContainerData=function(_,_,i) return balls[i+1] end;ctx.params.action='ball';ctx.params.preferSmallGroup=true;ctx.params.reserveColor=1;assert(input(ctx)=='running' and calls[1].key==2)")


def test_dodge_resource_is_separate_from_matrix_cooldown(tactics):
    tactics.execute("player.DodgeState=0;player.Attrib[2].Value=600;observe(ctx);assert(result.dodgeEnergy==600 and result.dodgeEnergyRatio==0.6 and not result.matrixReady)")
    tactics.execute("player.Attrib[2].Value=0;observe(ctx);assert(result.dodgeEnergyRatio==0)")

def test_retreat_angle_keeps_outward_and_sideways_movement(tactics):
    tactics.execute("ctx.params.mode='retreat';ctx.params.distance=14;ctx.params.angleDegrees=45;assert(approach(ctx)=='running');assert(moves[1].x<0 and moves[1].y<0)")


@pytest.mark.parametrize('radius,x,y', [(10, 0, 1), (12, -0.8, 0.6), (8, 0.8, 0.6)])
def test_orbit_keeps_moving_and_corrects_radius(tactics, radius, x, y):
    tactics.globals().ctx.params.mode='orbit'
    tactics.globals().ctx.params.distance=radius
    assert tactics.globals().approach(tactics.globals().ctx)=='running'
    move=tactics.globals().moves[1]
    assert move.x==pytest.approx(x) and move.y==pytest.approx(y)
    tactics.execute("ctx.memory.cleanup();assert(moves[#moves].power==0)")


def test_orbit_handles_overlapping_positions(tactics):
    tactics.execute("enemy.Position.x=0;ctx.params.mode='orbit';assert(approach(ctx)=='running');assert(moves[1].x==moves[1].x and moves[1].y==moves[1].y)")


def test_frontal_threat_excludes_player_behind_enemy(tactics):
    tactics.execute("enemy.SkillGroupComponent={CurrentSkill={Id=831005,RunFrame=8}};ctx.params.windows={{skillId=831005,fromFrame=4,toFrame=10,distance=12,frontDotMin=0}};observe(ctx);assert(result.enemy.facingDot==1 and enemyWindow(ctx)=='succeeded')")
    tactics.execute("enemy.Facing.x=1;observe(ctx);assert(result.enemy.facingDot==-1 and enemyWindow(ctx)=='failed')")
    tactics.execute("ctx.params.windows[1].frontDotMin=-1;assert(enemyWindow(ctx)=='succeeded')")

def test_observation_reports_actual_dodge_interval(tactics):
    tactics.execute("player.IsDodging=true;observe(ctx);assert(result.dodging)")


def test_empty_observation_maps_keep_object_shape(tactics):
    tactics.execute("enemy.IsDead=true;observe(ctx)")
    value=json.loads(tactics.globals().encodeResult())
    assert value['enemy']=={} and value['playerBuffs']=={} and value['enemyBuffs']=={}


def test_hit_control_and_life_loss_are_observed_without_deciding_strategy(tactics):
    tactics.execute("""
        CS.XNpcAction={Default=0,BeHit=2};CS.XNpcState={Invincible=26,ImmuneDamage=28}
        player.CurrentAction=0;player.IsCaught=false
        player.BeHitFSM={CurrentState='None',CanControl=function() return false end}
        player.CanMove=function() return false end
        player.IsState=function(_,state) return state==28 end
        observe(ctx)
        assert(result.controlKnown and not result.controlLocked and result.framesSinceLifeLoss==1000000000)
        player.CurrentAction=2;player.BeHitFSM.CurrentState='HitLeft'
        fight.Frame=7;player.Attrib[0].Value=70;observe(ctx)
        assert(result.controlLocked and result.beHit and result.lifeLost==30 and result.framesSinceLifeLoss==0)
        assert(result.immuneDamageKnown and result.immuneDamage and result.invincibleKnown and not result.invincible)
        assert(ctx.run.blackboard.hitRecovering==nil)
        player.BeHitFSM.CanControl=function() return true end
        fight.Frame=10;observe(ctx)
        assert(not result.controlLocked and result.beHit and result.framesSinceLifeLoss==3 and result.lifeLost==0)
        player.BeHitFSM=nil;observe(ctx)
        assert(not result.controlKnown and result.beHitState=='unknown')
    """)
