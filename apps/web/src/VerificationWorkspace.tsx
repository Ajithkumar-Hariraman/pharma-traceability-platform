import { useState } from 'react';
import {
  normalizeGtin,
  normalizeSerialNumber,
  type VerificationResult,
} from '@pharma/contracts';
import { authenticatedRequest } from './auth';
const labels: Record<VerificationResult['result'], string> = {
  VALID: 'Verified for current use',
  RECALLED: 'Active recall — do not use',
  QUARANTINED: 'Quarantined — hold this item',
  DECOMMISSIONED: 'Decommissioned — inactive item',
  UNKNOWN: 'Unable to confirm validity',
};
export function VerificationWorkspace({
  organizationId,
}: {
  organizationId: string;
}) {
  const [gtin, setGtin] = useState('');
  const [serialNumber, setSerial] = useState('');
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="verification-workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SERIALIZED PRODUCT VERIFICATION</p>
          <h1>Know the status. Protect the patient.</h1>
          <p className="muted">
            Check an individual pack against serialization, batch eligibility
            and active recalls in this organization.
          </p>
        </div>
      </div>
      <div className="verification-grid">
        <form
          className="domain-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setResult(null);
            const normalized = normalizeGtin(gtin);
            const serial = normalizeSerialNumber(serialNumber);
            if (!normalized || !serial) {
              setError(
                'Enter a valid GS1 GTIN and a serial number of 1–100 characters.',
              );
              return;
            }
            setBusy(true);
            try {
              setResult(
                await authenticatedRequest<VerificationResult>(
                  `/organizations/${organizationId}/verification`,
                  'POST',
                  { gtin: normalized, serialNumber: serial },
                ),
              );
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : 'Verification unavailable. Please retry.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Check a pharmaceutical pack</h2>
          <label htmlFor="verify-gtin">GTIN</label>
          <input
            id="verify-gtin"
            disabled={busy}
            inputMode="numeric"
            autoComplete="off"
            maxLength={14}
            required
            value={gtin}
            onChange={(e) => {
              setGtin(e.target.value);
              setResult(null);
            }}
          />
          <p className="input-help">
            Use the GS1 identifier printed beside the pack barcode.
          </p>
          <label htmlFor="verify-serial">Serial number</label>
          <input
            id="verify-serial"
            disabled={busy}
            autoComplete="off"
            required
            maxLength={100}
            value={serialNumber}
            onChange={(e) => {
              setSerial(e.target.value);
              setResult(null);
            }}
          />
          <button className="primary" disabled={busy}>
            {busy ? 'Checking current status…' : 'Verify product'}
          </button>
          {error && (
            <p role="alert" className="alert error">
              {error}
            </p>
          )}
        </form>
        <div aria-live="polite" aria-busy={busy}>
          {result ? (
            <article
              className={`verification-result result-${result.result.toLowerCase()}`}
            >
              <p className="eyebrow">VERIFICATION RESULT</p>
              <span className="verification-status">
                {result.result === 'VALID'
                  ? '✓'
                  : result.result === 'RECALLED'
                    ? '!'
                    : '○'}{' '}
                {result.result}
              </span>
              <h2>{labels[result.result]}</h2>
              <p>{result.explanation}</p>
              <dl>
                <dt>GTIN</dt>
                <dd>{result.gtin}</dd>
                <dt>Serial number</dt>
                <dd>{result.serialNumber}</dd>
                {result.productName && (
                  <>
                    <dt>Product</dt>
                    <dd>{result.productName}</dd>
                    <dt>Lot</dt>
                    <dd>{result.lotNumber}</dd>
                    <dt>Expiry</dt>
                    <dd>{result.expiryDate ?? 'Not recorded'}</dd>
                  </>
                )}
                {result.recall && (
                  <>
                    <dt>Recall</dt>
                    <dd>
                      {result.recall.recallNumber} · {result.recall.title}
                    </dd>
                    <dt>Classification</dt>
                    <dd>{result.recall.severity}</dd>
                    <dt>Recall reason</dt>
                    <dd>{result.recall.reason}</dd>
                  </>
                )}
              </dl>
              <p className="input-help">
                Checked {new Date(result.verifiedAt).toLocaleString()}. Status
                reflects the services queried at this time.
              </p>
            </article>
          ) : (
            <article className="verification-result verification-empty">
              <span className="verification-status">◎</span>
              <h2>One pack. A clear answer.</h2>
              <p>
                Enter the GTIN and serial to see whether this item is valid,
                recalled, quarantined, decommissioned, or unknown.
              </p>
              <p className="input-help">
                A failed service check never produces a valid result.
              </p>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
