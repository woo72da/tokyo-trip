#!/usr/bin/env python3
"""Record Japanese audio for every phrase and place name in data/trip.json (macOS only).

iPhone mutes the browser's speech engine when the ring/silent switch is on, but plays
<audio> files, so the app ships these recordings. Run again after editing phrases or places:

    python3 tools/make_audio.py

Writes audio/<hash>.m4a and audio/index.json ({text: file}); stale files are removed.
"""
import hashlib
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VOICE = 'Kyoko'
RATE = '165'  # words per minute, a little slower than default for listening


def texts(trip):
    out = [p['ja'] for p in trip['phrases']]
    out.append(trip['stay']['nameJa'])
    for day in trip['days']:
        for it in day['items']:
            place = it.get('place')
            if place and place.get('lang') != 'ko' and place.get('nameJa'):
                out.append(place['nameJa'])
    return list(dict.fromkeys(out))


def main():
    trip = json.loads((ROOT / 'data/trip.json').read_text())
    audio = ROOT / 'audio'
    audio.mkdir(exist_ok=True)
    index = {}
    with tempfile.TemporaryDirectory() as tmp:
        aiff = pathlib.Path(tmp) / 'say.aiff'
        for text in texts(trip):
            name = hashlib.sha1(text.encode()).hexdigest()[:12] + '.m4a'
            index[text] = f'audio/{name}'
            if (audio / name).exists():
                continue
            subprocess.run(['say', '-v', VOICE, '-r', RATE, '-o', str(aiff), text], check=True)
            subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '48000', '-c', '1', str(aiff), str(audio / name)], check=True)
    keep = {pathlib.Path(f).name for f in index.values()}
    for f in audio.glob('*.m4a'):
        if f.name not in keep:
            f.unlink()
    (audio / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1) + '\n')
    print(f'{len(index)} clips, {sum(f.stat().st_size for f in audio.glob("*.m4a")) // 1024} KB')


if __name__ == '__main__':
    main()
