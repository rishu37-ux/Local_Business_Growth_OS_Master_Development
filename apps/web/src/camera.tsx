// Take a photo for OCR (increment 12.4, D-071). Two ways, always both offered:
// - "Use camera": a live preview through getUserMedia (a laptop webcam on
//   http://127.0.0.1, or any device over https); "Take photo" captures a JPEG.
// - "Choose or take a photo": a file input that opens the phone camera
//   (capture="environment") or the file picker on a computer.
// The photo is handed to the caller; nothing is stored here.
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui.tsx';

export function TakePhoto(props: {
  /** Names the controls, e.g. "IMEI or barcode". */
  readonly what: string;
  readonly name: string;
  readonly onPhoto: (photo: Blob, name: string) => void;
  readonly busy?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Undefined outside secure contexts (e.g. a phone on http://<laptop-ip>), whatever the type says.
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  const canLive = typeof devices?.getUserMedia === 'function';

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
    return () => {
      stream?.getTracks().forEach((t) => {
        t.stop();
      });
    };
  }, [stream]);

  const open = async () => {
    setProblem(null);
    try {
      setStream(
        await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        }),
      );
    } catch {
      setProblem('The camera could not be opened. Allow camera access in the browser, or choose a photo instead.');
    }
  };
  const close = () => {
    stream?.getTracks().forEach((t) => {
      t.stop();
    });
    setStream(null);
  };
  const capture = () => {
    const v = video.current;
    if (!v || v.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) props.onPhoto(blob, 'camera.jpg');
        close();
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div className="mb-3 flex flex-col gap-2" data-testid={`take-photo-${props.name}`}>
      {stream ? (
        <div className="flex flex-col gap-2">
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            aria-label={`Camera preview for the ${props.what}`}
            className="w-full max-w-md rounded border border-ink-200 bg-black"
          />
          <div className="flex flex-wrap gap-2">
            <Button onPress={capture} isDisabled={props.busy === true}>
              Take photo<span className="sr-only"> of the {props.what}</span>
            </Button>
            <Button variant="secondary" onPress={close}>
              Close camera
            </Button>
          </div>
        </div>
      ) : canLive ? (
        <div>
          <Button variant="secondary" onPress={() => void open()} isDisabled={props.busy === true}>
            Use camera<span className="sr-only"> for the {props.what}</span>
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`photo-${props.name}`} className="text-sm font-medium text-ink-800">
          Or choose or take a photo of the {props.what}
        </label>
        <input
          id={`photo-${props.name}`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={props.busy === true}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onPhoto(f, f.name);
            e.target.value = '';
          }}
          className="max-w-full text-sm"
        />
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-red-800">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export interface PhotoLookupResult {
  readonly imeis: readonly {
    readonly imei: string;
    readonly unit: {
      readonly unitId: string;
      readonly variantId: string;
      readonly sku: string;
      readonly productName: string;
      readonly status: string;
    } | null;
  }[];
  readonly products: readonly {
    readonly variantId: string;
    readonly sku: string;
    readonly productName: string;
    readonly available: string;
    readonly sellingPricePaise: number;
  }[];
  readonly barcode: string | null;
}

/** A photo read at once by the server (12.2): the IMEIs and products it matches. The photo is not stored. */
export function PhotoLookup(props: {
  readonly businessId: string;
  readonly what: string;
  readonly name: string;
  readonly onResult: (result: PhotoLookupResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (photo: Blob) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${props.businessId}/scan-lookup`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: photo,
      });
      const data = (await res.json().catch(() => null)) as {
        lookup?: PhotoLookupResult;
        error?: { message?: string };
      } | null;
      if (!res.ok || !data?.lookup) throw new Error(data?.error?.message ?? 'The photo could not be read.');
      props.onResult(data.lookup);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The photo could not be read.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <TakePhoto what={props.what} name={props.name} busy={busy} onPhoto={(p) => void send(p)} />
      {busy ? (
        <p role="status" className="text-sm text-ink-600">
          Reading the photo…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
