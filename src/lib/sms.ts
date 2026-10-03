import "server-only";

export type SmsResult = { ok: true; devCode?: string } | { ok: false; error: string };

export function smsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER,
  );
}

/**
 * Sends a sign-in code. Without Twilio configured, development logs the code
 * and hands it back for the UI to show; production refuses.
 */
export async function sendLoginCode(phone: string, code: string, storeName: string): Promise<SmsResult> {
  const body = `${code} is your ${storeName} sign-in code. It expires in 10 minutes.`;

  if (smsConfigured()) {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: `+1${phone}`, From: process.env.TWILIO_FROM_NUMBER!, Body: body }),
    });
    if (res.ok) return { ok: true };
    console.error("Twilio send failed:", res.status, await res.text());
    return { ok: false, error: "We couldn't text that number. Check it and try again." };
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[sms:dev] to ${phone}: ${body}`);
    return { ok: true, devCode: code };
  }
  return { ok: false, error: "Text sign-in isn't set up yet. Ask the store." };
}
