import type { CallStatus, ReviewStatus, SourceMode } from "@calllog/shared";
import Image from "next/image";
import Link from "next/link";
import { StatusPill } from "@/components/StatusPill";
import { formatDate, formatDuration } from "@/lib/format";

export interface CallTableRow {
  id: string;
  title: string | null;
  ownerName: string;
  sourceMode: SourceMode;
  status: CallStatus;
  reviewStatus: ReviewStatus;
  startedAt: string;
  durationMs: number;
}

export function CallTable({
  calls,
  showOwner,
}: {
  calls: CallTableRow[];
  showOwner: boolean;
}) {
  if (calls.length === 0) {
    return (
      <div className="empty-state">
        <Image src="/cal-head.png" alt="" width={80} height={80} className="empty-cal" />
        <h2>No calls yet</h2>
        <p>Cal&rsquo;s ready when you are. New recordings appear here as soon as their upload begins.</p>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Call</th>
            {showOwner && <th className="hide-mobile">Owner</th>}
            <th className="hide-mobile">Source</th>
            <th>Processing</th>
            <th className="hide-mobile">Review</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => (
            <tr key={call.id}>
              <td>
                <Link href={`/calls/${call.id}`} className="table-primary">
                  <strong>{call.title || formatDate(call.startedAt)}</strong>
                  <span>{call.title ? formatDate(call.startedAt) : call.id.slice(0, 8)}</span>
                </Link>
              </td>
              {showOwner && <td className="hide-mobile">{call.ownerName}</td>}
              <td className="hide-mobile call-source">{call.sourceMode}</td>
              <td><StatusPill status={call.status} /></td>
              <td className="hide-mobile"><StatusPill status={call.reviewStatus} /></td>
              <td className="mono">{formatDuration(call.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
