export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <div className="rounded-md border bg-card px-8 py-10 text-center shadow-xs">
        <p className="eyebrow mb-3">Internal use only</p>
        <h1 className="font-display text-4xl text-charcoal">
          Marley <span className="text-mm-red">Ops</span>
        </h1>
        <p className="mt-2 text-sm text-mist-400">
          Admin panel — foundation in progress.
        </p>
      </div>
    </main>
  );
}
