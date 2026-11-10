-- 普攻短按经正常输入门禁提交；观察到指定技能开始才成功，超时失败交给树分支处理。
BehaviorTreeCapabilityChecks['fight.normal_attack']={kind='fight',controllable=true,available=function(fight)
    local player=fight:GetClientRole()
    local npc=player and player.Npc
    local ok, forced=pcall(function() return CS.XInputControl.ForceClickForDebug end)
    return ok and forced==false and fight.InputControl~=nil and fight.InputControl.OnClick~=nil
        and CS.XNpcOperationClickKey.NormalAttackKey~=nil and CS.XOperationClickType.KeyDown~=nil and CS.XOperationClickType.KeyUp~=nil and fight.State==CS.XFightState.Fight
        and not fight.IsReplay and not fight.IsLockstep and not fight.ShieldOperation
        and npc~=nil and npc.IsActivate and not npc.IsDead and not npc.IsDeleted
        and (player.ControlNpc==nil or player.ControlNpc==npc) and npc.SkillGroupComponent~=nil
end}
BehaviorTreeHandlers.fight_normal_attack=function(ctx)
    local fight=ctx.object(ctx.params.role)
    local ok, available=pcall(BehaviorTreeCapabilityChecks['fight.normal_attack'].available,fight)
    if not ok or not available then
        ctx.write(ctx.params.output,{phase='failed',reason='input_capability_lost'})
        return 'failed'
    end
    local npc=fight:GetClientRole().Npc
    local skill=npc.SkillGroupComponent.CurrentSkill
    if not ctx.memory.started then
        ctx.memory.started=ctx.now
        ctx.memory.skill=skill
        ctx.memory.skillId=skill and skill.Id
        ctx.memory.skillFrame=skill and skill.RunFrame
        -- 同次调用完成按下/抬起，不持有跨帧按键，也不预排长组合。
        local input=fight.InputControl
        local key=CS.XNpcOperationClickKey.NormalAttackKey
        ctx.memory.cleanup=function() input:OnClick(key,CS.XOperationClickType.KeyUp,false) end
        input:OnClick(key,CS.XOperationClickType.KeyDown,false)
        input:OnClick(key,CS.XOperationClickType.KeyUp,false)
        ctx.memory.cleanup=nil
        ctx.write(ctx.params.output,{phase='submitted',frame=fight.Frame})
        return 'running'
    end
    -- 技能对象可能复用，每次观察都保存值，不能一直与提交时的帧号比较。
    if skill and skill.Id==ctx.params.expectedSkillId and (skill~=ctx.memory.skill or skill.Id~=ctx.memory.skillId or (ctx.memory.skillFrame and skill.RunFrame<ctx.memory.skillFrame)) then
        ctx.write(ctx.params.output,{phase='skill_started',skillId=skill.Id,frame=fight.Frame})
        return 'succeeded'
    end
    ctx.memory.skill=skill
    ctx.memory.skillId=skill and skill.Id
    ctx.memory.skillFrame=skill and skill.RunFrame
    if ctx.now-ctx.memory.started>=ctx.params.timeout then
        ctx.write(ctx.params.output,{phase='failed',frame=fight.Frame,reason='no_skill_start_evidence',expectedSkillId=ctx.params.expectedSkillId,observedSkillId=skill and skill.Id})
        return 'failed'
    end
    return 'running'
end
