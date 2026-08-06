// DB 백업 — pg 접속만으로 전체 테이블을 JSON 한 파일에 담는다.
//
// pg_dump나 docker exec에 기대지 않는다: 그 둘은 없거나 버전이 어긋날 수 있고, 백업은
// 그런 사정과 무관하게 되어야 한다. 대신 형식은 앱이 읽을 수 있는 JSON이라 되살릴 때도 앱만 있으면 된다.
// (도커 볼륨 하나에 모든 데이터가 있다는 게 이 앱의 유일한 단일 실패점이었다.)
import fs from 'node:fs';
import path from 'node:path';
// 하루의 경계는 브리핑과 같은 규칙을 쓴다 — 기능마다 "오늘"이 다르면 설명할 수 없는 앱이 된다.
import { dayKey } from './brief.mjs';

export const BACKUP_KEEP = 8;
const NAME_RE = /^whenwork-(\d{8})-(\d{4})\.json$/;

// 오늘 한 번은 남겼는가. 주간 리뷰에 얹어두었더니 리뷰를 만들지 않은 이틀 동안 사본이
// 하나도 없었다 — 백업은 다른 기능을 타고 다니면 안 된다.
//
// lastTry가 따로 있는 이유: 실패한 날 60초마다 다시 두드리면 실패 알림만 쌓인다. 그날은
// 손을 뗀다. 다만 DB가 꺼져 있어 시작조차 못 한 것은 시도로 치지 않는다(호출자가 판단한다).
export function backupDue({ lastBackup = null, lastTry = null, now = new Date() } = {}) {
  const today = dayKey(now);
  if (lastTry === today) return false;
  if (!lastBackup) return true;
  const at = new Date(lastBackup);
  if (Number.isNaN(at.getTime())) return true; // 값이 깨졌으면 남기는 쪽으로 기운다
  return dayKey(at) !== today;
}

export function backupName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `whenwork-${d}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

// 지워야 할 백업 이름들. 파일명이 시간순이라 이름 정렬만으로 오래된 것을 고를 수 있다.
// 우리가 만든 이름 규칙에 맞는 것만 건드린다 — 남의 파일을 지우지 않는다.
export function staleBackups(names, keep = BACKUP_KEEP) {
  const mine = names.filter((n) => NAME_RE.test(n)).sort();
  return mine.slice(0, Math.max(0, mine.length - keep));
}

export function writeBackup(dir, tables, { now = new Date(), keep = BACKUP_KEEP } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupName(now));
  const body = { app: 'whenwork', at: now.toISOString(), tables };
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  for (const name of staleBackups(fs.readdirSync(dir), keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // 지우지 못한 오래된 백업은 그냥 남겨둔다 — 백업이 실패로 끝나는 것보다 낫다
    }
  }
  return file;
}
