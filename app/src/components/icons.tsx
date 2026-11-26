// 여러 화면이 함께 쓰는 작은 기호. 글자색(currentColor)을 따라가고, 뜻은 옆의 글자가 전하므로 보조 기술에는 숨긴다.
export function CheckIcon({ size = 12 }: Readonly<{ size?: number }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path
        d="m2.5 6.3 2.4 2.4 4.6-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
