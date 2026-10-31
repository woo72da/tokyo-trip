#!/usr/bin/env python3
"""Write calendar.ics from the schedule items in data/trip.json that have an "alarm".

iPhone web apps can't raise alerts while closed without a push server, so the must-not-miss
stops go into the phone's calendar instead. Run again after changing their times:

    python3 tools/make_ics.py
"""
import datetime as dt
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
JST = dt.timezone(dt.timedelta(hours=9))  # Seoul and Tokyo share this offset


def esc(text):
    return text.replace('\\', '\\\\').replace(';', '\;').replace(',', '\\,').replace('\n', '\\n')


def fold(line):
    """Split a content line at 75 bytes without breaking a character."""
    out, cur = [], ''
    for ch in line:
        if len((cur + ch).encode()) > 74:
            out.append(cur)
            cur = ' '
        cur += ch
    return '\r\n'.join(out + [cur])


def stamp(when):
    return when.astimezone(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def main():
    trip = json.loads((ROOT / 'data/trip.json').read_text())
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tokyo-trip//KO', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:도쿄 여행']
    count = 0
    for day in trip['days']:
        for it in day['items']:
            if 'alarm' not in it:
                continue
            start = dt.datetime.fromisoformat(f"{day['date']}T{it['start']}:00").replace(tzinfo=JST)
            end = dt.datetime.fromisoformat(f"{day['date']}T{it['end']}:00").replace(tzinfo=JST) if it.get('end') else start + dt.timedelta(minutes=30)
            title = it.get('alarmTitle') or it['title']
            lines += [
                'BEGIN:VEVENT',
                f"UID:{it['id']}@tokyo-trip",
                f'DTSTAMP:{stamp(dt.datetime(2026, 10, 31, tzinfo=JST))}',
                f'DTSTART:{stamp(start)}',
                f'DTEND:{stamp(end)}',
                f'SUMMARY:{esc(title)}',
            ]
            if it.get('note'):
                lines.append(f"DESCRIPTION:{esc(it['note'])}")
            lines += ['BEGIN:VALARM', 'ACTION:DISPLAY', f'DESCRIPTION:{esc(title)}', f"TRIGGER:-PT{it['alarm']}M", 'END:VALARM', 'END:VEVENT']
            count += 1
    lines.append('END:VCALENDAR')
    (ROOT / 'calendar.ics').write_bytes(('\r\n'.join(fold(l) for l in lines) + '\r\n').encode())
    print(f'{count} events')


if __name__ == '__main__':
    main()
