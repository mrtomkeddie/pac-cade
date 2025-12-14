import zipfile, wave, io, json
zip_path = r"assets/samples/dkong.zip"
expected = ["dkstomp.wav","effect00.wav","effect01.wav","effect02.wav","jump.wav","run01.wav","run02.wav","run03.wav"]
results = []
with zipfile.ZipFile(zip_path, 'r') as z:
    names = z.namelist()
    for name in expected:
        entry = next((n for n in names if n.endswith(name)), None)
        if not entry:
            results.append({"name": name, "present": False, "format_ok": False, "reason": "Missing"})
            continue
        data = z.read(entry)
        try:
            wf = wave.open(io.BytesIO(data), 'rb')
            channels = wf.getnchannels()
            rate = wf.getframerate()
            width = wf.getsampwidth()
            frames = wf.getnframes()
            duration = (frames / float(rate)) if rate else None
            # attempt to read a small chunk
            _ = wf.readframes(min(frames, 1024))
            wf.close()
            format_ok = (channels == 2 and rate == 44100 and width == 2)
            results.append({"name": name, "present": True, "format_ok": format_ok, "channels": channels, "rate": rate, "bits": (width*8), "duration_sec": duration, "entry": entry, "reason": "OK" if format_ok else "Format mismatch"})
        except Exception as e:
            results.append({"name": name, "present": True, "format_ok": False, "entry": entry, "reason": str(e)})
print(json.dumps(results, indent=2))
