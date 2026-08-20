import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main-content" className="hero">
      <div className="hero-inner">
        <p className="eyebrow">One source. Explicit authority.</p>
        <h1>Configuration that converges with proof.</h1>
        <p className="hero-copy">
          Canonfig publishes immutable Machine Profile revisions from one Source
          Machine, then plans, applies, and independently verifies them on Linux,
          macOS, and Windows Follower Machines.
        </p>
        <nav className="hero-actions" aria-label="Documentation shortcuts">
          <Link href="/docs">Start with the concepts</Link>
          <Link href="/docs/source/setup">Set up a Source Machine</Link>
          <Link href="/docs/reference/cli">Read the CLI reference</Link>
        </nav>
      </div>
    </main>
  );
}
