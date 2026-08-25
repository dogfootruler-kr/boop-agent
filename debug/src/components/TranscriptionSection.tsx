import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Mic01Icon } from "@hugeicons/core-free-icons";
import { panelCardClass, subtlePanelClass } from "./PanelPrimitives.js";

type TranscriptionProvider = "local" | "remote";
type TranscriberState = "ready" | "will-download" | "unreachable";

interface TranscriptionSettings {
  provider: TranscriptionProvider;
  url: string;
  model: string;
  localModel: string;
  language: string;
  apiKeyConfigured: boolean;
}

interface TranscriberStatus {
  provider: TranscriptionProvider;
  description: string;
  state: TranscriberState;
  warm: boolean;
  detail?: string;
}

interface LocalModelChoice {
  value: string;
  label: string;
  note: string;
}

interface TranscriptionResponse {
  settings: TranscriptionSettings;
  status: TranscriberStatus;
  localModelChoices: LocalModelChoice[];
  defaults: { localModel: string; remoteModel: string };
}

/**
 * Languages Whisper handles well, offered as a list because this is the one
 * setting that fails silently when it is wrong: Whisper does not detect the
 * language, so the wrong value returns fluent nonsense instead of an error.
 */
const LANGUAGES = [
  "english",
  "german",
  "french",
  "spanish",
  "italian",
  "portuguese",
  "dutch",
  "polish",
  "russian",
  "japanese",
  "chinese",
];

const STATE_LABEL: Record<TranscriberState, string> = {
  ready: "Ready",
  "will-download": "Model not downloaded",
  unreachable: "Not reachable",
};

export function TranscriptionSection({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<TranscriptionResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const pollRef = useRef<number | null>(null);

  const apply = useCallback((next: TranscriptionResponse) => {
    setData(next);
    setUrlDraft(next.settings.url);
    setModelDraft(next.settings.model);
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/transcription/status");
      if (!res.ok) throw new Error(`status ${res.status}`);
      apply((await res.json()) as TranscriptionResponse);
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
      setLoaded(true);
    }
  }, [apply]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // While a model is downloading nothing pushes an update, so the section
  // polls until it is warm and then stops. Cleared on unmount so a closed
  // settings tab does not keep asking.
  useEffect(() => {
    const downloading = busy === "Download" || (data?.status.state === "will-download" && busy !== null);
    if (!downloading) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = window.setInterval(refresh, 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [busy, data?.status.state, refresh]);

  async function post(path: string, body?: unknown, label = "Save") {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(`/api/transcription/${path}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `status ${res.status}`);
      apply(parsed as TranscriptionResponse);
      return parsed as TranscriptionResponse;
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      setBusy(null);
    }
  }

  const settings = data?.settings;
  const status = data?.status;
  const provider = settings?.provider ?? "local";
  const muted = isDark ? "text-zinc-400" : "text-zinc-500";
  const subtle = isDark ? "text-zinc-500" : "text-zinc-400";
  const label = isDark ? "text-zinc-50" : "text-zinc-950";

  async function chooseProvider(next: TranscriptionProvider) {
    if (next === provider) return;
    // The endpoint IS the provider switch: an empty URL means in-process.
    const url = next === "remote" ? urlDraft || "http://127.0.0.1:8080/v1/audio/transcriptions" : "";
    const result = await post("settings", { url }, "Provider");
    if (result) {
      setMessage({
        tone: "ok",
        text:
          next === "remote"
            ? "Voice notes now go to your transcription endpoint."
            : "Voice notes are transcribed on this machine.",
      });
    }
  }

  return (
    <section className={panelCardClass(isDark, "fade-in overflow-hidden")}>
      <div className="px-4 py-4 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className={`h-10 w-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
              isDark ? "bg-white/5 text-zinc-300" : "bg-zinc-100 text-zinc-700"
            }`}
          >
            <HugeiconsIcon icon={Mic01Icon} size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className={`text-sm font-medium ${label}`}>Voice notes</div>
            <div className={`text-xs mt-1 leading-relaxed max-w-3xl ${muted}`}>
              Hold the mic button in Telegram and Boop transcribes the note, then answers it as if
              you had typed it.
            </div>
            <div className={`text-[10px] mono mt-2 ${subtle}`}>
              {loaded && status ? status.description : "loading…"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {status && <StatePill status={status} isDark={isDark} />}
        </div>
      </div>

      <div className={`border-t px-4 py-4 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
        <div className="flex flex-wrap gap-2">
          <ChoiceButton
            active={provider === "local"}
            disabled={!loaded || busy !== null}
            isDark={isDark}
            title="On this machine"
            note="Free, nothing to install, audio never leaves"
            onClick={() => chooseProvider("local")}
          />
          <ChoiceButton
            active={provider === "remote"}
            disabled={!loaded || busy !== null}
            isDark={isDark}
            title="A transcription server"
            note="OpenASR, vLLM, Groq, OpenAI — reaches Qwen3-ASR"
            onClick={() => chooseProvider("remote")}
          />
        </div>

        {provider === "local" ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label="Language"
              hint="Whisper does not detect this. Set wrong, a note comes back as fluent nonsense rather than an error."
              isDark={isDark}
            >
              <select
                value={settings?.language || "english"}
                disabled={!loaded || busy !== null}
                onChange={(e) => post("settings", { language: e.target.value }, "Language")}
                className={selectClass(isDark)}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang.charAt(0).toUpperCase() + lang.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model" hint="Bigger is better outside English, and slower." isDark={isDark}>
              <select
                value={settings?.localModel ?? ""}
                disabled={!loaded || busy !== null}
                onChange={(e) => post("settings", { localModel: e.target.value }, "Model")}
                className={selectClass(isDark)}
              >
                {(data?.localModelChoices ?? []).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label} — {choice.note}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Endpoint" hint="Must speak OpenAI's /v1/audio/transcriptions." isDark={isDark}>
              <input
                value={urlDraft}
                disabled={!loaded || busy !== null}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => urlDraft !== settings?.url && post("settings", { url: urlDraft }, "Endpoint")}
                placeholder="http://127.0.0.1:8080/v1/audio/transcriptions"
                className={inputClass(isDark)}
              />
            </Field>
            <Field label="Model" hint="The name that endpoint knows it by." isDark={isDark}>
              <input
                value={modelDraft}
                disabled={!loaded || busy !== null}
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={() =>
                  modelDraft !== settings?.model && post("settings", { model: modelDraft }, "Model")
                }
                placeholder="qwen3-asr-0.6b"
                className={inputClass(isDark)}
              />
            </Field>
          </div>
        )}

        {status?.state === "will-download" && (
          <Callout tone="warn" isDark={isDark}>
            <span>
              The model has not been downloaded yet, so your first voice note will wait for it.
            </span>
            <ActionButton
              isDark={isDark}
              disabled={busy !== null}
              onClick={() => post("preload", undefined, "Download")}
            >
              {busy === "Download" ? "Downloading…" : "Download now"}
            </ActionButton>
          </Callout>
        )}

        {status?.state === "unreachable" && (
          <Callout tone="error" isDark={isDark}>
            <span>{status.detail ?? "Nothing answered at that endpoint."}</span>
            <ActionButton
              isDark={isDark}
              disabled={busy !== null}
              onClick={() => post("recheck", undefined, "Recheck")}
            >
              {busy === "Recheck" ? "Checking…" : "Check again"}
            </ActionButton>
          </Callout>
        )}

        {provider === "remote" && !settings?.apiKeyConfigured && (
          <div className={subtlePanelClass(isDark, "mt-3 px-3 py-3 text-xs leading-relaxed text-zinc-500")}>
            No API key is set. A local server does not need one; a hosted endpoint does — put it in
            <span className="mono"> BOOP_TRANSCRIBE_API_KEY</span> in <span className="mono">.env.local</span>.
            Keys are deliberately not editable here.
          </div>
        )}

        {message && (
          <div
            className={`mt-3 text-xs ${
              message.tone === "ok"
                ? isDark
                  ? "text-emerald-300"
                  : "text-emerald-700"
                : isDark
                  ? "text-rose-300"
                  : "text-rose-600"
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </section>
  );
}

function StatePill({ status, isDark }: { status: TranscriberStatus; isDark: boolean }) {
  const ok = status.state === "ready";
  const warn = status.state === "will-download";
  const tone = ok
    ? isDark
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
      : "border-emerald-200 bg-emerald-50 text-emerald-700"
    : warn
      ? isDark
        ? "border-amber-500/25 bg-amber-500/10 text-amber-300"
        : "border-amber-200 bg-amber-50 text-amber-800"
      : isDark
        ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
        : "border-rose-200 bg-rose-50 text-rose-700";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
      <span
        className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : warn ? "bg-amber-400" : "bg-rose-400"}`}
      />
      {STATE_LABEL[status.state]}
      {ok && status.warm && <span className="opacity-70">· warm</span>}
    </span>
  );
}

function ChoiceButton({
  active,
  disabled,
  isDark,
  title,
  note,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  isDark: boolean;
  title: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 min-w-[200px] rounded-2xl border px-3 py-2.5 text-left transition-colors ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${
        active
          ? isDark
            ? "border-emerald-500/40 bg-emerald-500/10"
            : "border-emerald-300 bg-emerald-50"
          : isDark
            ? "border-white/10 hover:bg-white/5"
            : "border-zinc-200 hover:bg-zinc-50"
      }`}
    >
      <span className={`block text-xs font-medium ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
        {title}
      </span>
      <span className={`block text-[11px] mt-0.5 ${isDark ? "text-zinc-400" : "text-zinc-500"}`}>
        {note}
      </span>
    </button>
  );
}

function Field({
  label,
  hint,
  isDark,
  children,
}: {
  label: string;
  hint: string;
  isDark: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className={`text-xs font-medium ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{label}</div>
      {children}
      <div className={`text-[11px] mt-1.5 leading-relaxed ${isDark ? "text-zinc-500" : "text-zinc-400"}`}>
        {hint}
      </div>
    </div>
  );
}

function Callout({
  tone,
  isDark,
  children,
}: {
  tone: "warn" | "error";
  isDark: boolean;
  children: React.ReactNode;
}) {
  const cls =
    tone === "warn"
      ? isDark
        ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
        : "border-amber-200 bg-amber-50 text-amber-800"
      : isDark
        ? "border-rose-500/25 bg-rose-500/10 text-rose-200"
        : "border-rose-200 bg-rose-50 text-rose-700";
  return (
    <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-relaxed ${cls}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">{children}</div>
    </div>
  );
}

function ActionButton({
  isDark,
  disabled,
  onClick,
  children,
}: {
  isDark: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded-xl px-2.5 py-1.5 text-xs font-medium transition-colors ${
        isDark
          ? "bg-zinc-100 text-zinc-950 hover:bg-white disabled:opacity-50"
          : "bg-zinc-950 text-white hover:bg-zinc-800 disabled:opacity-50"
      }`}
    >
      {children}
    </button>
  );
}

function selectClass(isDark: boolean) {
  return `mt-1.5 w-full rounded-xl border px-2.5 py-1.5 text-xs outline-none transition-colors ${
    isDark
      ? "border-white/10 bg-zinc-900 text-zinc-100 focus:border-white/25"
      : "border-zinc-200 bg-white text-zinc-900 focus:border-zinc-400"
  }`;
}

function inputClass(isDark: boolean) {
  return `mt-1.5 w-full rounded-xl border px-2.5 py-1.5 text-xs mono outline-none transition-colors ${
    isDark
      ? "border-white/10 bg-zinc-900 text-zinc-100 focus:border-white/25"
      : "border-zinc-200 bg-white text-zinc-900 focus:border-zinc-400"
  }`;
}
