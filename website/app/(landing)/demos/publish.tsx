import { FillPattern } from '../dither';
import { DitherBand } from '../dither-band';
import { FOLLOWERS, IconTile } from './machine';
import { Offscreen } from './offscreen';
import './publish.css';

// The Overview header's states in order, in the GUI's words
// (ui/src/workspace/source.tsx).
const TITLES = ['1 unpublished change', 'Publishing revision 8…', 'Sending revision 8', 'Everything is published'];

/**
 * A publish, drawn as the GUI's Overview and played on a 10s loop
 * (publish.css): a pointer presses Publish revision 8, the header runs through
 * the GUI's states while its dithered band turns from amber to green, and each
 * follower's row fills a dithered progress bar and lands on revision 8. Real
 * followers take it at their next check; the scene compresses that wait.
 * An illustration, so it is one image to assistive tech and takes no pointer
 * events; the frame around it is the link into the interactive demo.
 */
export function PublishScene() {
  return (
    <Offscreen className="pub">
      <div
        className="pub-window"
        role="img"
        aria-label="The canonfig workspace on atlas publishing revision 8: the header goes from 1 unpublished change to Everything is published, and laptop, studio, gaming-pc and build-box each move from revision 7 to revision 8."
      >
        <div className="pub-chrome" aria-hidden="true">
          <span className="pub-lights">
            <i />
            <i />
            <i />
          </span>
          <span>atlas · Overview</span>
        </div>

        <div className="pub-head">
          <DitherBand className="pub-band pub-band-warn" />
          <DitherBand className="pub-band pub-band-ok" />
          <span className="pub-titles">
            {TITLES.map((title, index) => (
              <span key={title} className={`pub-title pub-title-${index + 1}`}>
                {title}
              </span>
            ))}
          </span>
          <span className="pub-action">
            <span className="pub-button">Publish revision 8</span>
            <svg className="pub-cursor" viewBox="0 0 16 20" width="16" height="20">
              <path d="M1 1v15l4-4 3 7 3-1.5-3-6.5h6z" />
            </svg>
          </span>
        </div>

        <div className="pub-change">
          <span className="pub-badge">M</span>
          rules/typescript
          <code>rules/typescript.md</code>
        </div>

        <ul className="pub-machines">
          {FOLLOWERS.map((machine, index) => (
            <li key={machine.name} style={{ '--animation-delay': `${index * 250}ms` }}>
              <svg className="pub-tile" viewBox="0 0 26 26">
                <IconTile id={`pub-${machine.name}`} accent={machine.accent} icon={machine.icon} />
              </svg>
              <span className="pub-name">
                <b>{machine.name}</b>
                <span>{machine.platform}</span>
              </span>
              <svg className="pub-progress" viewBox="0 0 60 6" preserveAspectRatio="none">
                <defs>
                  <FillPattern id={`pub-bar-${machine.name}`} fill="ramp-x" color="var(--sa-ok)" cell={1} width={60} from={1} to={0.25} />
                </defs>
                <rect width="60" height="6" fill={`url(#pub-bar-${machine.name})`} />
              </svg>
              <span className="pub-states">
                <span className="pub-old">
                  rev 7
                </span>
                <span className="pub-new">
                  <svg width="11" height="11" viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="6" fill="currentColor" />
                    <path d="M4.4 7.2 6.2 9 9.6 5.3" fill="none" stroke="var(--sa-1)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  rev 8
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Offscreen>
  );
}
