/**
 * WHENWORK 캘린더 연동용 Apps Script 웹앱.
 *
 * 왜 이 방식인가 (설계 오픈이슈 #6):
 *   회사 Workspace가 iCal 비공개 주소를 막아 두어 앱이 폴링할 피드가 없었다.
 *   공개 iCal은 캘린더를 인터넷에 공개해야 하는 데다 "한가함/바쁨"만 나와 제목이 오지 않는다.
 *   이 웹앱은 **내 권한으로** 캘린더를 읽으므로 캘린더를 공개하지 않아도 되고,
 *   getEvents가 반복 일정을 이미 펼쳐서 주므로 앱이 RRULE을 해석할 필요도 없다.
 *
 * 배포 방법:
 *   1. script.google.com에서 새 프로젝트 → 이 파일 내용을 붙여넣기
 *   2. TOKEN을 길고 임의적인 값으로 바꾼다 (이름에서 유추되는 문자열은 쓰지 않는다)
 *   3. 배포 → 새 배포 → 유형 "웹 앱"
 *      - 실행 계정: 나
 *      - 액세스 권한이 있는 사용자: **모든 사용자**  ← 이게 아니면 앱이 403을 받는다
 *   4. 나온 URL 뒤에 ?token=<TOKEN>을 붙여 WHENWORK 설정 탭의 "캘린더 웹앱 URL"에 넣는다
 *
 * 보안:
 *   "모든 사용자"로 열어야 인증 없이 폴링할 수 있으므로 URL과 토큰이 곧 비밀이다.
 *   그래서 내보내는 필드를 제목·시각·장소로 제한한다 — 참석자·본문·첨부는 나가지 않는다.
 *   유출이 의심되면 TOKEN을 바꿔 새 버전으로 배포하면 즉시 무효가 된다.
 */

const TOKEN = 'CHANGE_ME';

function doGet(e) {
  if (e.parameter.token !== TOKEN) {
    return ContentService.createTextOutput('no').setMimeType(ContentService.MimeType.TEXT);
  }

  // 앱이 back·ahead를 넘긴다. 과거도 받는 이유는 주간 리뷰가 지난주 회의를 재료로 쓰기 때문이다.
  const back = Number(e.parameter.back || 7);
  const ahead = Number(e.parameter.ahead || 14);
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const from = new Date(base.getTime() - back * 86400000);
  const to = new Date(base.getTime() + ahead * 86400000);

  const events = CalendarApp.getDefaultCalendar()
    .getEvents(from, to)
    .map(function (ev) {
      return {
        id: ev.getId(),
        title: ev.getTitle(),
        start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(),
        allDay: ev.isAllDayEvent(),
        location: ev.getLocation() || null,
      };
    });

  return ContentService.createTextOutput(
    JSON.stringify({ from: from.toISOString(), to: to.toISOString(), events: events })
  ).setMimeType(ContentService.MimeType.JSON);
}
