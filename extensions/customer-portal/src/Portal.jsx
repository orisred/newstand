import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

// The app's portal API. Extensions have no environment, so this is set per deployment.
const API = 'https://release-subscriptions.ne-dev.workers.dev/api/portal';

export default async () => {
  render(<Portal />, document.body);
};

// The customer is whoever Shopify's session token says; the API never takes one from us.
async function call(method, body) {
  const token = await shopify.sessionToken.get();
  const response = await fetch(API, {
    method,
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
  return data;
}

const valueOf = (event) => /** @type {any} */ (event.target).value;

function Portal() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const reload = () =>
    call('GET').then(setData, () => setFailed(true));
  useEffect(() => {
    reload();
  }, []);

  if (failed) {
    return (
      <s-banner tone="critical">We couldn&apos;t load your subscription. Please refresh the page.</s-banner>
    );
  }
  if (!data) return <s-text>Loading…</s-text>;
  // Nothing to show a customer with no subscription here: stay out of their Profile page.
  if (data.subscriptions.length === 0) return null;
  return (
    <s-stack gap="large">
      <s-heading>{data.copy.heading}</s-heading>
      {data.subscriptions.map((subscription) => (
        <Subscription key={subscription.id} data={data} subscription={subscription} reload={reload} />
      ))}
    </s-stack>
  );
}

const FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['address1', 'Address'],
  ['address2', 'Apartment, suite, etc.'],
  ['city', 'City'],
  ['provinceCode', 'State'],
  ['zip', 'ZIP code'],
  ['countryCode', 'Country code'],
  ['phone', 'Phone'],
];

function Subscription({data, subscription, reload}) {
  const {copy} = data;
  const [view, setView] = useState(null); // 'address' | 'cancel'
  const [form, setForm] = useState({});
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const cancelled = subscription.status === 'CANCELLED';

  const act = async (body, then) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await call('POST', {subscriptionId: subscription.id, ...body});
      await then?.(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-section heading={subscription.plan}>
      <s-stack gap="base">
        {note && <s-banner tone="success">{note}</s-banner>}
        {error && <s-banner tone="critical">{error}</s-banner>}
        {subscription.onHold && (
          <s-banner tone="warning">Your subscription is on hold after a payment dispute. Please contact the shop.</s-banner>
        )}
        {subscription.cardProblem && !subscription.onHold && (
          <s-banner tone="warning">
            We couldn&apos;t charge your card. Update it below and we&apos;ll try again.
          </s-banner>
        )}
        {cancelled && <s-banner tone="info">This subscription is cancelled.</s-banner>}
        {subscription.gift && (
          <>
            <s-banner tone="info">{copy.giftNote}</s-banner>
            {subscription.giftMessage && (
              <s-stack gap="small-200">
                <s-text color="subdued">{copy.giftMessageLabel}</s-text>
                <s-text>{subscription.giftMessage}</s-text>
              </s-stack>
            )}
          </>
        )}

        <s-heading>{copy.upcomingHeading}</s-heading>
        {subscription.upcoming.length === 0 ? (
          <s-text>{copy.noUpcoming}</s-text>
        ) : (
          subscription.upcoming.map((release) => (
            <s-stack key={release.id} gap="small-200">
              <s-text type="strong">{release.title}</s-text>
              <s-text>{release.state}</s-text>
              {release.confirmable && (
                release.confirmed ? (
                  <s-text>Delivery address confirmed</s-text>
                ) : (
                  <s-button
                    disabled={busy}
                    onClick={() =>
                      act({intent: 'confirm', releaseId: release.id}, async (r) => {
                        setNote(r.message ?? null);
                        await reload();
                      })
                    }
                  >
                    My delivery address is right
                  </s-button>
                )
              )}
            </s-stack>
          ))
        )}

        {!cancelled && subscription.address && (
          <>
            <s-heading>Delivery address</s-heading>
            <s-text>
              {[subscription.address.firstName, subscription.address.lastName].filter(Boolean).join(' ')}
              {', '}
              {[subscription.address.address1, subscription.address.address2, subscription.address.city, subscription.address.provinceCode, subscription.address.zip, subscription.address.countryCode].filter(Boolean).join(', ')}
            </s-text>
            <s-text color="subdued">{copy.addressNote}</s-text>
            {view === 'address' ? (
              <s-stack gap="small">
                {FIELDS.map(([key, label]) => (
                  <s-text-field
                    key={key}
                    label={label}
                    value={form[key] ?? ''}
                    onInput={(e) => setForm({...form, [key]: valueOf(e)})}
                  />
                ))}
                <s-stack direction="inline" gap="small">
                  <s-button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      act({intent: 'address', address: form}, async () => {
                        setView(null);
                        setNote('Your delivery address is saved.');
                        await reload();
                      })
                    }
                  >
                    Save address
                  </s-button>
                  <s-button onClick={() => setView(null)}>Back</s-button>
                </s-stack>
              </s-stack>
            ) : (
              <s-button
                onClick={() => {
                  setForm({...subscription.address});
                  setView('address');
                }}
              >
                Change address
              </s-button>
            )}
          </>
        )}

        {!cancelled && !subscription.gift && (
          <>
            <s-heading>Payment</s-heading>
            <s-text>{subscription.card ?? 'No card on file'}</s-text>
            <s-text color="subdued">{copy.cardNote}</s-text>
            <s-stack direction="inline" gap="small">
              <s-button
                disabled={busy}
                onClick={() => act({intent: 'card'}, (r) => setNote(r.message ?? null))}
              >
                Email me a link to update my card
              </s-button>
              {subscription.cardProblem && !subscription.onHold && (
                <s-button
                  disabled={busy}
                  onClick={() =>
                    act({intent: 'resume'}, (r) => setNote(r.message ?? null))
                  }
                >
                  I&apos;ve updated my card, try again
                </s-button>
              )}
            </s-stack>
          </>
        )}

        {!cancelled && !subscription.gift && (
          <>
            <s-heading>Cancel</s-heading>
            {view === 'cancel' ? (
              <s-stack gap="small">
                <s-text>{subscription.cancelNote}</s-text>
                <s-stack direction="inline" gap="small">
                  <s-button
                    tone="critical"
                    disabled={busy}
                    onClick={() =>
                      act({intent: 'cancel'}, async (r) => {
                        setView(null);
                        setNote(r.message ?? null);
                        await reload();
                      })
                    }
                  >
                    Cancel my subscription
                  </s-button>
                  <s-button onClick={() => setView(null)}>Keep my subscription</s-button>
                </s-stack>
              </s-stack>
            ) : (
              <s-button tone="critical" onClick={() => setView('cancel')}>
                Cancel subscription
              </s-button>
            )}
          </>
        )}
      </s-stack>
    </s-section>
  );
}
