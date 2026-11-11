-- 头像的 QTE 和切人共用按键；只在已激活且窗口充足时短按，不主动切人。
local function teamNumber(value)
    local n=BehaviorTreeFight.number(value)
    if not n or n~=n or math.abs(n)==math.huge then return nil end
    return n
end
local function teamNote(role,id)
    local ok,value=pcall(function()
        local key=CS.System.Convert.ToInt32(id)
        if not role.NoteTable:ContainsKey(key) then return nil end
        return teamNumber(role.NoteTable[key])
    end)
    if not ok then return false,nil end
    return value~=nil,value
end
local function teamMembers(role)
    local count=role.NpcTable.Count
    if count<1 or count>3 then error('unsupported_team_size') end
    local members={}
    for i=0,count-1 do
        local npc=role.NpcTable[i]
        local index=npc and npc.Index
        if not npc or npc.Role~=role or type(index)~='number' or index%1~=0 or index<0 or index>2
            or members[index+1] then error('team_identity_unknown') end
        members[index+1]=npc
    end
    return members,count
end
local function teamAvailable(fight)
    local role=fight:GetClientRole()
    if not role or not role.Npc or role.Npc.IsDeleted then return false end
    teamMembers(role)
    return true
end
local function qteWindow(fight,role,npc,minimum)
    local index=npc.Index
    local stateKnown,state=teamNote(role,2021+index)
    local identityKnown,identity=teamNote(role,2041+index)
    local windowKnown,ends=teamNote(role,2051+index)
    local remaining=windowKnown and ends-fight.Frame or nil
    local identityMatches=identityKnown and identity==npc.Id
    local ready=npc~=role.Npc and not npc.IsDead and not npc.IsDeleted and not npc.IsActivate
        and npc.QteState==CS.XNpcQteState.Activated and stateKnown and state==1 and identityMatches
        and windowKnown and remaining>=minimum
    return ready==true,{noteStateKnown=stateKnown,noteState=state,noteIdentityKnown=identityKnown,
        noteIdentityMatches=identityMatches,windowKnown=windowKnown,remainingFrames=remaining}
end
BehaviorTreeCapabilityChecks['fight.team.read']={kind='fight',controllable=false,available=teamAvailable}
BehaviorTreeCapabilityChecks['fight.qte']={kind='fight',controllable=true,available=function(fight)
    return teamAvailable(fight) and BehaviorTreeFight.available(fight)
        and CS.XNpcQteState~=nil and CS.XNpcOperationClickKey.ChangeNpcIndexBegin~=nil
end}
BehaviorTreeHandlers.fight_team_observe=function(ctx)
    local fight=ctx.object(ctx.params.role)
    local ok,value=pcall(function()
        local role=fight:GetClientRole()
        local members,count=teamMembers(role)
        local report={known=true,frame=fight.Frame,count=count,currentNpcId=role.Npc.Id,
            currentIndex=role.Npc.Index,activeMain=role.Npc.IsActivate==true,members={}}
        if role.Captain then report.captainNpcId=role.Captain.Id;report.captainIndex=role.Captain.Index end
        for slot,npc in pairs(members) do
            local canQte,entry=qteWindow(fight,role,npc,6)
            entry.known=true;entry.slot=slot;entry.index=npc.Index;entry.npcId=npc.Id;entry.templateId=npc.TemplateId
            entry.isCurrent=npc==role.Npc;entry.isActivate=npc.IsActivate==true
            entry.isDead=npc.IsDead==true;entry.isDeleted=npc.IsDeleted==true
            entry.qteState=CS.System.Convert.ToInt32(npc.QteState);entry.canQte=canQte
            local skill=npc.SkillGroupComponent and npc.SkillGroupComponent.CurrentSkill
            entry.currentSkillId=skill and skill.Id;entry.currentSkillFrame=skill and skill.RunFrame
            local start=ctx.run.combat and ctx.run.combat.qteStarts and ctx.run.combat.qteStarts[slot]
            if start then entry.lastStartedFrame=start.frame;entry.lastStartedSkillId=start.skillId end
            report.members[tostring(slot)]=entry
        end
        return report
    end)
    if not ok then ctx.write(ctx.params.output,{known=false,reason='team_observation_unknown'});return 'failed' end
    ctx.write(ctx.params.output,value)
    return 'succeeded'
end
local function qteRelease(ctx)
    if ctx.memory.cleanup then ctx.memory.cleanup();ctx.memory.cleanup=nil end
end
local function qteReport(ctx,fight,phase,reason)
    local m=ctx.memory
    ctx.write(ctx.params.output,{phase=phase,reason=reason,frame=fight.Frame,targetSlot=ctx.params.targetSlot,
        npcId=m.target and m.target.Id,templateId=m.target and m.target.TemplateId,
        expectedSkillId=ctx.params.expectedSkillId,observedSkillId=m.skillId,
        runningObserved=m.runningObserved==true,skillStartObserved=m.skillStartObserved==true})
end
BehaviorTreeHandlers.fight_qte=function(ctx)
    local p,m=ctx.params,ctx.memory
    local fight=ctx.object(p.role)
    local availableOk,available=pcall(BehaviorTreeCapabilityChecks['fight.qte'].available,fight)
    if not availableOk or not available then
        qteRelease(ctx);qteReport(ctx,fight,'failed','qte_capability_lost');return 'failed'
    end
    local role=fight:GetClientRole()
    local members=teamMembers(role)
    if m.started then
        local same=role==m.role and role.Npc==m.main
        for slot,npc in pairs(m.members) do if members[slot]~=npc then same=false end end
        for slot,npc in pairs(members) do if m.members[slot]~=npc then same=false end end
        if not same or m.target.IsDeleted or m.target.IsDead then
            qteRelease(ctx);qteReport(ctx,fight,'failed','team_changed');return 'failed'
        end
        local skill=m.target.SkillGroupComponent and m.target.SkillGroupComponent.CurrentSkill
        if m.target.QteState==CS.XNpcQteState.Running then m.runningObserved=true end
        if skill and skill.Id==p.expectedSkillId and (skill~=m.skill or skill.Id~=m.skillId
            or (m.skillFrame and skill.RunFrame<m.skillFrame)) then m.skillStartObserved=true end
        m.skill,m.skillId,m.skillFrame=skill,skill and skill.Id,skill and skill.RunFrame
        if m.runningObserved and m.skillStartObserved then
            ctx.run.combat=ctx.run.combat or {}
            ctx.run.combat.qteStarts=ctx.run.combat.qteStarts or {}
            ctx.run.combat.qteStarts[p.targetSlot]={frame=fight.Frame,skillId=p.expectedSkillId,
                npcId=m.target.Id,templateId=m.target.TemplateId}
            qteReport(ctx,fight,'qte_started');return 'succeeded'
        end
        if ctx.now-m.started>=p.timeout then
            qteReport(ctx,fight,'failed','no_qte_start_evidence');return 'failed'
        end
        return 'running'
    end
    local target=members[p.targetSlot]
    m.target=target
    if not target or target.TemplateId~=p.expectedTemplateId then
        qteReport(ctx,fight,'failed','teammate_mismatch');return 'failed'
    end
    local ready=qteWindow(fight,role,target,p.minimumWindowFrames or 6)
    if not ready then qteReport(ctx,fight,'failed','qte_not_activated');return 'failed' end
    local skill=target.SkillGroupComponent and target.SkillGroupComponent.CurrentSkill
    m.started=ctx.now;m.role=role;m.main=role.Npc;m.members=members
    m.skill,m.skillId,m.skillFrame=skill,skill and skill.Id,skill and skill.RunFrame
    local key=CS.System.Convert.ToByte(CS.System.Convert.ToInt32(CS.XNpcOperationClickKey.ChangeNpcIndexBegin)+target.Index)
    local input=fight.InputControl
    m.cleanup=function() input:OnClick(key,CS.XOperationClickType.KeyUp,false) end
    input:OnClick(key,CS.XOperationClickType.KeyDown,false)
    qteRelease(ctx)
    -- 只证明正常按键已提交；QTE 起手还须等实际 NPC 状态与技能证据。
    qteReport(ctx,fight,'input_submitted')
    return 'running'
end
