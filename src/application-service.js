import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.

// [구현 추가] 명세의 409 오류 코드
const alreadyApplied = () => new AppError(409,'ALREADY_APPLIED','이미 이 행사에 신청한 기록이 있습니다.');
const capacityFull = () => new AppError(409,'CAPACITY_FULL','행사 정원이 모두 찼습니다.');

export function createApplicationService(repo) {
  // [구현 추가] 트랜잭션 경계: BEGIN IMMEDIATE → work() 성공 시 COMMIT, 예외(4xx 거부·500 저장 오류) 시 ROLLBACK 후 재던짐.
  // IMMEDIATE는 시작 시점에 쓰기 잠금을 잡아 검사~저장 사이에 다른 연결이 상태·정원을 바꾸지 못하게 합니다.
  const db=repo.db;
  function inTransaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result=work(); db.exec('COMMIT'); return result; }
    catch(err) { if(db.isTransaction) db.exec('ROLLBACK'); throw err; }
  }
  // [구현 추가] 대기 순서: 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건 (취소·다른 행사 제외)
  function nextWaiting(eventId) {
    const row=db.prepare(`SELECT id FROM applications WHERE event_id=? AND status='PENDING'
      ORDER BY created_at ASC, id ASC LIMIT 1`).get(eventId);
    return row ? row.id : null;
  }
  // [구현 추가] 신청 존재(404) → 담당 운영자 권한(403) 순서 검사
  function loadForManager(actor,applicationId) {
    const app=repo.application(applicationId); if(!app) throw missing('신청');
    const event=repo.event(app.eventId);
    if(actor.role!=='MANAGER'||event.managerId!==actor.id) throw forbidden();
    return {app,event};
  }
  return {
    apply(actor,eventId) {
      // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
      // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
      return inTransaction(()=>{
        const event=repo.event(eventId); if(!event) throw missing('행사');   // 404
        if(actor.role!=='STUDENT') throw forbidden();                          // 403
        if(repo.existing(eventId,actor.id)) throw alreadyApplied();            // 409 (CANCELLED·REVOKED 포함)
        const created=repo.insert(eventId,actor.id);                           // PENDING 저장
        repo.addHistory({applicationId:created.id,actorId:actor.id,action:'APPLY',fromStatus:null,toStatus:'PENDING'});
        return created;
      });
    },
    cancel(actor,applicationId) {
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
      return inTransaction(()=>{
        const app=repo.application(applicationId); if(!app) throw missing('신청');   // 404
        if(actor.role!=='STUDENT'||app.userId!==actor.id) throw forbidden();          // 403
        if(app.status!=='PENDING') throw invalidState();                              // 409
        const updated=repo.setStatus(app.id,'CANCELLED');
        repo.addHistory({applicationId:app.id,actorId:actor.id,action:'CANCEL',fromStatus:'PENDING',toStatus:'CANCELLED'});
        return updated;
      });
    },
    approve(actor,applicationId) {
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
      return inTransaction(()=>{
        const {app,event}=loadForManager(actor,applicationId);                        // 404 → 403
        if(app.status!=='PENDING') throw invalidState();                              // 409
        if(repo.approvedCount(event.id)>=event.capacity) throw capacityFull();        // 409
        const updated=repo.setStatus(app.id,'APPROVED');
        repo.addHistory({applicationId:app.id,actorId:actor.id,action:'APPROVE',fromStatus:'PENDING',toStatus:'APPROVED'});
        return updated;
      });
    },
    revoke(actor,applicationId,reason) {
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
      return inTransaction(()=>{
        const {app}=loadForManager(actor,applicationId);                              // 404 → 403
        if(app.status!=='APPROVED') throw invalidState();                             // 409 (반복 승인 취소 포함)
        const revoked=repo.setStatus(app.id,'REVOKED');
        const revokeHistoryId=repo.addHistory({applicationId:app.id,actorId:actor.id,action:'REVOKE',fromStatus:'APPROVED',toStatus:'REVOKED',reason});
        let promoted=null;
        const nextId=nextWaiting(app.eventId);                                        // 요청당 최대 1명
        if(nextId!==null) {
          promoted=repo.setStatus(nextId,'APPROVED');
          repo.addHistory({applicationId:nextId,actorId:actor.id,action:'AUTO_APPROVE',fromStatus:'PENDING',toStatus:'APPROVED',causeHistoryId:revokeHistoryId});
        }
        return {revoked,promoted};
      });
    }
  };
}