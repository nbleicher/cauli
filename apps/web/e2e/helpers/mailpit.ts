interface MailpitAddress {
  Address: string;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: MailpitAddress[];
}

interface MailpitMessage extends MailpitSummary {
  HTML: string;
  Text: string;
}

const mailpitUrl = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

export async function waitForEmail(
  recipient: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitUrl}/api/v1/messages`);
    if (!response.ok) throw new Error("Unable to query Mailpit");
    const result = (await response.json()) as { messages: MailpitSummary[] };
    const summary = result.messages.find((message) =>
      message.To.some(
        (address) => address.Address.toLowerCase() === recipient.toLowerCase()
      )
    );
    if (summary) {
      const messageResponse = await fetch(
        `${mailpitUrl}/api/v1/message/${summary.ID}`
      );
      if (!messageResponse.ok)
        throw new Error("Unable to read Mailpit message");
      return (await messageResponse.json()) as MailpitMessage;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No email arrived for ${recipient}`);
}

export function emailLinks(message: MailpitMessage) {
  return [
    ...`${message.HTML}\n${message.Text}`.matchAll(/https?:\/\/[^\s"'<>]+/g),
  ]
    .map(([link]) => link.replaceAll("&amp;", "&"))
    .filter((link, index, links) => links.indexOf(link) === index);
}
