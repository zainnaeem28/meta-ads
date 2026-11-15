import { loadSections } from './registry';

export default function GalleryPage() {
  const sections = loadSections();
  return (
    <main className="p-6">
      <h1 className="text-page font-semibold">Component gallery</h1>
      <nav aria-label="Gallery sections">
        <ul className="flex flex-wrap gap-4 py-4">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.id}</a>
            </li>
          ))}
        </ul>
      </nav>
      {sections.map(({ id, title, Component }) => (
        <section key={id} id={id} aria-labelledby={`${id}-title`} className="py-6">
          <h2 id={`${id}-title`} className="text-section font-semibold">
            {id} {title}
          </h2>
          <Component />
        </section>
      ))}
    </main>
  );
}
