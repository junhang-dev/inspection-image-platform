# 지도 시각 자산

2026-09-21 사용자의 지도 개선 요청에 따라 생성한 배경이다. 업로드 사진이나 학습 자료가 아니며, AI로 보강한 시각 참고 이미지다. 생성 과정에서 세부 배관·설비 모양이 재구성되었으므로 실제 위치·측량·설비 식별 근거로 사용하지 않는다. 팀·랙·포인트는 앱에서 별도의 가상 좌표와 안정 ID로 연결한다.

| 파일 | 입력 출처 | 실제 출력 크기 | SHA-256 |
|---|---|---|---|
| `refinery-overview-v1.png` | 사용자 제공 Google Earth 항공 캡처 1종(동일한 첨부 2개) | 1189 × 1323 | `5ee4b476ef07d78cbc1f4db65c9b87e0a9ff84fd1ddc700c2dc6bcf5f27fad47` |
| `refinery-rack-v1.png` | 기존 승인 `ref/3d map.png` | 1403 × 1121 | `9cef51ad0ca6a8c27d79e543d4669330f17310e31fcb9dd05e3db80d269f07fa` |

입력 SHA-256: 항공 캡처 `fdf8df0320a8766d10f19acbba564648ed83700258e3ddae2ac24d5c1babccf5`, 기존 3D 그림 `c004c1da3c20300cd7c3bb7a954a331d40726a0e6af35a024ab681bbac64e354`.

도구는 Codex 내장 image generation 편집 모드다. 2048px 너비를 목표로 요청했지만 실제 반환 크기는 위 표와 같으며 2048px 출력이라고 보고하지 않는다. 입력 원본은 보존했다. 텍스트·핀·구역은 배경 이미지에 넣지 않았고, 코드에서 구현할 대상이다. 두 배경이 정확히 일치하는 실제 지리 계층이라고 단정하지 않는다. UI에는 ‘AI 보강 참고 이미지 · 가상 구역/포인트’ 표시를 제공한다.

요청 프롬프트는 아래에 보존한다. 형상 보존은 생성 요청의 목표이며 출력이 측량 수준으로 정확하다는 검증 주장이 아니다.

## 항공 배경 프롬프트

Use case: precise-object-edit. Asset type: high-resolution base map for a refinery inspection and maintenance web application. Input image 1 is the only edit target, a low-resolution Google Earth-style overhead refinery screenshot provided by the user. Upscale and carefully restore this exact satellite photograph, aiming for about 2048 pixels wide with the identical portrait aspect ratio. Preserve the exact footprint, orientation, crop, major roads, crossing corridors, tank positions and counts, buildings, vegetation, roof shapes and all existing relative geometry. Improve legibility by removing compression haze, modestly sharpening edges and making tonal separation clearer; retain natural muted aerial colors and lighting. Do not invent new pipes, buildings, machinery, roads, labels, geographic data, borders, or geometry. Do not convert to an illustration or 3D render. No baked-in text, title, team names, pins, grid, UI, or polygons; interactive zones will be implemented separately in code. Preserve any existing attribution or watermark rather than removing it. Return one faithful high-resolution image only. This is a visual reference, not a measured engineering map.

## 파이프랙 상세 프롬프트

Use case: precise-object-edit. Asset type: high-resolution pipe-rack detail base image for a refinery inspection and maintenance web application. Input image 1 is the only edit target: the user's existing low-resolution aerial oblique 3D photogrammetry refinery map. Upscale and carefully restore this exact view at around 2048 pixels wide, preserving its landscape aspect ratio, orientation, crop, relative positions and sizes of major buildings, pipe racks, roads, open paved areas and visible equipment. Reduce compression blur and modestly improve contrast and edge clarity while keeping natural aerial photographic colors. Preserve the existing view rather than redesigning the plant. Do not infer or invent hidden pipes, equipment, road connections, measurements or precise engineering details. Where photogrammetry is distorted, keep it visually neutral instead of inventing certainty. Do not add text, labels, pins, numbers, highlighted paths, colored zones, grids, logos or UI; interactive rack and point overlays will be implemented separately in code. Preserve any existing attribution and watermark. Return one high-resolution image. This is an AI-enhanced visual reference with virtual interactive coordinates, not a surveyed engineering model.
