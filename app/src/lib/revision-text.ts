// 계획의 revision을 화면에 쓰는 문구. revision은 저장할 때마다 1씩 오르므로 몇 번째 저장인지로 쓴다.
export function revisionLabel(revision: number): string {
  return `${revision}번째 저장`;
}
