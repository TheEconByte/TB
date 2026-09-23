# 공공파일 검증 재현

`verify_market.py`는 pandas로 원본 파일을 읽어 키·행 수·결합을 검사하는 별도 도구다. 웹앱의 데이터 적재 코드가 아니다.

## 원본 준비

저장소 루트 `data/raw/`처럼 Git에서 제외된 폴더에 아래 파일을 준비한다.

| 로컬 파일명 | 공식 자료 | 2026-09-09 다운로드 seq |
|---|---|---|
| sales-2024.zip | [추정매출 OA-15572](https://data.seoul.go.kr/dataList/OA-15572/S/1/datasetView.do) 2024 | 50 |
| sales-2025.zip | 같은 자료 2025 | 51 |
| stores-2024.zip | [점포 OA-15577](https://data.seoul.go.kr/dataList/OA-15577/S/1/datasetView.do) 2024 | 19 |
| stores-2025.zip | 같은 자료 2025 | 20 |
| areas.zip | [영역 OA-15560](https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do) | 5 |

공식 페이지에서 해당 파일을 내려받아 이름을 맞춘다. 다운로드 파라미터는 `market-verification.json`의 source_downloads에 보존했다. 제공자가 파일을 교체할 수 있으므로 seq를 영구적인 API 계약으로 가정하지 않는다. 당시 원본과 동일성은 manifest의 SHA-256으로 판별한다.

## 실행

Python 3.11 이상과 pandas가 필요하다. 별도 가상환경을 권장한다.

```sh
python -m pip install -r docs/verification/requirements.txt
python docs/verification/verify_market.py --source-dir data/raw
```

원본 ZIP은 수정하지 않는다. 결과는 `data/raw/market-verification.json`에 생성된다. 저장소의 기존 결과는 2026-09-10 검사 증거이므로 새 파일을 검토하기 전 덮어쓰지 않는다.

이 스크립트의 검사 대상 연도·다운로드 기록은 당시 표본에 고정돼 있다. 새로운 연도나 릴리스를 검사하려면 매핑과 기록을 함께 갱신한다. 연도가 다른 파일을 이름만 바꾸어 입력하지 않는다.

출력에서 결합률 100%는 매출 행을 기준으로 한다. 점포만 있는 조합의 매출이 0이라는 뜻이 아니다. 시간 단위·모집단·경계의 역사적 일치를 증명하는 도구도 아니다.
