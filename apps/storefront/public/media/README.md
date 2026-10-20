# Cinematic media

All supplied SVGs are authored illustrations, not photographs, actual operations,
analytical results, or molecular structures. Captions are part of the UI.

Local folders:
- `hero/`: vial / pedestal poster
- `molecular/`: abstract research editorial poster
- `laboratory/`: architectural concept poster
- `products/`: reserved for approved product photography
- `research/`: reserved for research editorial imagery
- `quality/`: reserved for approved documentation imagery
- `videos/`: reserved for approved motion assets

The central manifest is `lib/media.ts`. Video slots intentionally remain `null`.
To enable a slot, supply a real local video, then set its manifest path. Playback
is muted, intersection-controlled, suspended in hidden tabs, and disabled for
reduced motion. The SVG poster remains the fallback on failure.
Do not substitute fabricated certificates or purity results for missing records.
