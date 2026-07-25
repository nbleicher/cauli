import { RecorderPanel } from "@/components/RecorderPanel";
import { PageHeader } from "@/components/PageHeader";

export default function RecordPage() {
  return (
    <main className="page page-narrow">
      <PageHeader
        title="Record a call"
        description="Capture microphone, browser-tab audio, or both in one synchronized recording."
      />
      <RecorderPanel />
    </main>
  );
}
