"""Tiny FIT encoder to produce a Garmin-like activity with HR, speed, laps, hrv (RR) and a developer SmO2 field.
Used only to test js/fit.js's generic decoding path. Output: test/data/synthetic_garmin.fit"""
import struct, os

FIT_EPOCH = 631065600

def crc16(data, crc=0):
    tbl = [0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400]
    for b in data:
        tmp = tbl[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ tmp ^ tbl[b & 0xF]
        tmp = tbl[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ tmp ^ tbl[(b >> 4) & 0xF]
    return crc

def definition(local, global_num, fields, dev_fields=None):
    hdr = 0x40 | local | (0x20 if dev_fields else 0)
    out = bytes([hdr, 0, 0]) + struct.pack('<H', global_num) + bytes([len(fields)])
    for num, size, btype in fields: out += bytes([num, size, btype])
    if dev_fields:
        out += bytes([len(dev_fields)])
        for num, size, idx in dev_fields: out += bytes([num, size, idx])
    return out

def data(local, payload): return bytes([local]) + payload

def build():
    body = b''
    t0 = 1790478718  # unix seconds (2026-09-27 ~03:11 UTC)
    ts = t0 - FIT_EPOCH
    # file_id (0): type(0,enum), manufacturer(1,u16), product(2,u16), serial(3,u32z), time_created(4,u32)
    body += definition(0, 0, [(0,1,0x00),(1,2,0x84),(2,2,0x84),(3,4,0x8C),(4,4,0x86)])
    body += data(0, struct.pack('<BHHII', 4, 1, 3990, 12345, ts))
    # developer_data_id (207): developer_data_index(3,u8), application_id(1,16 bytes)
    body += definition(1, 207, [(3,1,0x02),(1,16,0x0D)])
    body += data(1, bytes([0]) + bytes(range(16)))
    # field_description (206): dev idx(0,u8), field def num(1,u8), base type(2,u8), name(3,string 16), units(8,string 8)
    body += definition(2, 206, [(0,1,0x02),(1,1,0x02),(2,1,0x02),(3,16,0x07),(8,8,0x07),(6,1,0x02),(7,1,0x01)])
    body += data(2, bytes([0, 0, 0x84]) + b'SmO2'.ljust(16, b'\0') + b'%'.ljust(8, b'\0') + bytes([10, 0]))
    # record (20): timestamp(253,u32), heart_rate(3,u8), speed(6,u16), distance(5,u32) + dev field 0:0 (u16, SmO2*10)
    body += definition(3, 20, [(253,4,0x86),(3,1,0x02),(6,2,0x84),(5,4,0x86)], dev_fields=[(0,2,0)])
    # hrv (78): time(0, array of u16 /1000) — up to 5 values per message
    body += definition(4, 78, [(0,10,0x84)])
    # lap (19): timestamp(253,u32), start_time(2,u32), total_elapsed_time(7,u32), total_distance(9,u32)
    body += definition(5, 19, [(253,4,0x86),(2,4,0x86),(7,4,0x86),(9,4,0x86)])
    # session (18): timestamp, start_time(2), sport(5,enum), total_elapsed_time(7), total_distance(9)
    body += definition(6, 18, [(253,4,0x86),(2,4,0x86),(5,1,0x00),(7,4,0x86),(9,4,0x86)])
    expected = {'records': [], 'rr': [], 'laps': []}
    dist = 0.0; lap_start = ts; rr_acc = 0.0
    for sec in range(0, 600):  # 10 minutes, 1 Hz
        stage = sec // 180
        hr = 110 + 12*stage + (sec % 7) * 0.3
        speed_ms = (7 + stage) / 3.6
        dist += speed_ms
        smo2 = 70 - 2.5*stage + 0.1*(sec % 5)
        body += data(3, struct.pack('<IBHI', ts + sec, int(hr), int(speed_ms*1000), int(dist*100)) + struct.pack('<H', int(smo2*10)))
        expected['records'].append((ts+sec+FIT_EPOCH, int(hr), int(smo2*10)/10))
        # RR intervals for this second: ~60000/hr ms until we fill one second
        rrs = []
        while rr_acc < 1000:
            rr = 60000.0/hr; rrs.append(rr); rr_acc += rr
        rr_acc -= 1000
        vals = [int(round(r)) for r in rrs][:5]; expected['rr'] += vals
        vals += [0xFFFF]*(5-len(vals))
        body += data(4, struct.pack('<5H', *vals))
        if (sec+1) % 180 == 0 or sec == 599:
            body += data(5, struct.pack('<IIII', ts+sec, lap_start, (ts+sec-lap_start)*1000, int(dist*100)))
            expected['laps'].append(((lap_start+FIT_EPOCH)*1000, (ts+sec+FIT_EPOCH)*1000))
            lap_start = ts+sec+1
    body += data(6, struct.pack('<IIBII', ts+599, ts, 1, 599000, int(dist*100)))
    header = struct.pack('<BBHI4s', 14, 0x20, 2195, len(body), b'.FIT')
    header += struct.pack('<H', crc16(header))
    blob = header + body
    blob += struct.pack('<H', crc16(blob))
    return blob, expected

if __name__ == '__main__':
    import json
    blob, exp = build()
    here = os.path.dirname(os.path.abspath(__file__))
    open(os.path.join(here, 'data', 'synthetic_garmin.fit'), 'wb').write(blob)
    json.dump({'nRecords': len(exp['records']), 'firstHr': exp['records'][0][1], 'lastHr': exp['records'][-1][1],
               'firstSmo2': exp['records'][0][2], 'nRr': len(exp['rr']), 'rrSum': sum(exp['rr']), 'laps': exp['laps']},
              open(os.path.join(here, 'data', 'synthetic_garmin.json'), 'w'))
    print('wrote', len(blob), 'bytes;', len(exp['records']), 'records;', len(exp['rr']), 'RR;', len(exp['laps']), 'laps')
