// Live streaming log panel — renders SSE lines and shows the current phase.
// Auto-scroll is "sticky": it only follows new output when you're already at the bottom.
// Scroll up to read earlier lines and it leaves your view alone until you return to the bottom.
import React, { useEffect, useLayoutEffect, useRef } from "react";

export default function LogPanel({ lines, phase, running }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true); // are we pinned to the bottom?

  // Track whether the user is at (near) the bottom; that decides if we auto-follow.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // After new lines render, only jump to the bottom if we were already there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="card log-card">
      <div className="card-head">
        <h2>Deployment log</h2>
        <span className={`phase ${running ? "running" : ""}`}>{phase || "idle"}</span>
      </div>
      <div className="log" ref={scrollRef} onScroll={onScroll}>
        {lines.length === 0 && <div className="muted">No output yet. Fill the form and click Deploy.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`log-line ${l.level || "info"}`}>
            <span className="ts">{l.ts}</span>
            <span className="txt">{l.line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
