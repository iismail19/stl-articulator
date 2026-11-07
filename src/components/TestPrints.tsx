import { useEffect, useState } from 'react'
import { HINGE_TEST } from '../lib/hingeProfile'
import { KNUCKLE_TEST } from '../lib/knuckleProfile'
import { stlThumbnail } from '../lib/stlThumbnail'
import { SWIVEL_TEST } from '../lib/swivelProfile'

interface Piece {
  label: string
  file: string
}

interface TestPair {
  title: string
  kind: string
  tested: boolean
  summary: string
  pieces: Piece[]
  howTo: string
  check?: string
}

const DIR = '/test-joints/'

const TESTS: TestPair[] = [
  {
    title: 'Ball & socket — Ø8 mm',
    kind: 'Ball & socket',
    tested: true,
    summary: 'The validated snap. PLA and PLA+ both use it.',
    pieces: [
      { label: 'Ball + stem', file: 'pla-ball-stem-v12.stl' },
      { label: 'Socket', file: 'pla-socket-v12.stl' },
    ],
    howTo:
      'Socket opening up, ball pointing up. 0.2 mm layers, 3–4 walls. Let them cool, then push the ball straight in.',
  },
  {
    title: 'Ball & socket — small Ø4 mm, angled',
    kind: 'Ball & socket',
    tested: true,
    summary: 'Small joint with the face cut at 22°, like an elbow.',
    pieces: [
      { label: 'Ball + stem', file: 'pla-d4-angled-ball-stem-v12.stl' },
      { label: 'Socket', file: 'pla-d4-angled-socket-v12.stl' },
    ],
    howTo: 'Print flat side down, as exported.',
  },
  {
    title: 'Knuckle — standard',
    kind: 'Knuckle',
    tested: true,
    summary:
      'Toy-robot elbow / knee: a rounded tongue in a fork, no separate pin. 9 mm wide, 2 mm cheeks. Print-tested: clicks in, holds a pose.',
    pieces: [
      { label: 'Fork (bumps)', file: `knuckle-fork-${KNUCKLE_TEST.version}.stl` },
      { label: 'Tongue (dimples)', file: `knuckle-tongue-${KNUCKLE_TEST.version}.stl` },
    ],
    howTo:
      'Both lying on their side, as exported. No supports. Slide the tongue into the fork until the bumps click into the dimples.',
  },
  {
    title: 'Knuckle — thin (Dag 4″ knee size)',
    kind: 'Knuckle',
    tested: true,
    summary:
      'Same fit, built as thin as the Dag 4″ knee: 6.8 mm wide, 1.6 mm cheeks, 3.2 mm tongue. Print-tested: clicks in, holds a pose.',
    pieces: [
      { label: 'Fork (bumps)', file: `knuckle-dag4-knee-fork-${KNUCKLE_TEST.version}.stl` },
      { label: 'Tongue (dimples)', file: `knuckle-dag4-knee-tongue-${KNUCKLE_TEST.version}.stl` },
    ],
    howTo: 'Both lying on their side, as exported. No supports.',
  },
  {
    title: 'Hinge — snap disc',
    kind: 'Hinge',
    tested: true,
    summary:
      'Elbow / knee where a ball stem would be too thin. Peg molded on one disc, hole in the other. Print-tested: snaps through, turns and holds.',
    pieces: [
      { label: 'Stud (peg)', file: `hinge-stud-${HINGE_TEST.version}.stl` },
      { label: 'Eye (hole)', file: `hinge-eye-${HINGE_TEST.version}.stl` },
    ],
    howTo:
      'Stud upright, arm end down, with a brim: the peg prints sideways, so its layers run along it and it’s stronger. Eye flat, as exported. Press the peg through the hole until it clicks; the lip clamps the discs so the bend holds.',
  },
  {
    title: 'Swivel — snap post',
    kind: 'Swivel',
    tested: false,
    summary:
      'Forearm or waist twist. A split Ø3 mm post on one Ø8 mm collar clicks into a hole in the other and turns all the way round. v2: deeper 0.3 mm lip, longer split, and the hole part prints hole-down so the catch edge comes out crisp (v1 popped out when twisted).',
    pieces: [
      { label: 'Post', file: `swivel-post-${SWIVEL_TEST.version}.stl` },
      { label: 'Bore (hole)', file: `swivel-bore-${SWIVEL_TEST.version}.stl` },
    ],
    howTo:
      'As exported: post part lying on its small flat (post sideways, like the hinge stud), bore part standing with the hole DOWN on the bed. No supports. Push the post into the hole until it clicks.',
    check:
      'Does the post click in without cracking? Does it stay in when you twist it? Does it turn all the way round and hold where you leave it?',
  },
]

function PieceCard({ piece }: { piece: Piece }) {
  const url = DIR + piece.file
  const [img, setImg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    stlThumbnail(url)
      .then((src) => live && setImg(src))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [url])
  return (
    <div className="piece">
      <div className="piece-thumb">
        {img ? <img src={img} alt={piece.label} /> : <span className="muted">{failed ? 'No preview' : 'Loading…'}</span>}
      </div>
      <div className="piece-label">{piece.label}</div>
      <a className="btn btn-primary btn-sm" href={url} download>
        Download STL
      </a>
    </div>
  )
}

export function TestPrints() {
  return (
    <div className="tests-page">
      <header className="tests-head">
        <div>
          <h1>Test prints</h1>
          <p className="muted">
            Print a pair before using that joint on a model. PLA or PLA+, 0.2 mm layers, 3–4 walls. Each pair is
            about 15–30 minutes.
          </p>
        </div>
        <a className="btn btn-ghost" href="/">
          ← Back to the editor
        </a>
      </header>
      <div className="tests-grid">
        {TESTS.map((t) => (
          <section key={t.title} className="test-card">
            <div className="test-card-head">
              <h2>{t.title}</h2>
              <span className={`badge ${t.tested ? 'badge-ok' : 'badge-todo'}`}>
                {t.tested ? 'Print-tested' : 'Needs a test print'}
              </span>
            </div>
            <p className="muted">{t.summary}</p>
            <div className="pieces">
              {t.pieces.map((p) => (
                <PieceCard key={p.file} piece={p} />
              ))}
            </div>
            <p className="filament-hint">
              <strong>Print:</strong> {t.howTo}
            </p>
            {t.check && (
              <p className="filament-hint">
                <strong>Tell me:</strong> {t.check}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
