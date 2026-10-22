/**
 * The two glyphs of the manual backup rows: one box, two directions.
 *
 * 导出 and 导入 are the same act read from either end, so they are drawn as the
 * same box — the lid, the body, and one arrow inside — with only the arrow turned
 * round: out of the box for 导出, into it for 导入. Drawn here rather than taken
 * from the icon set because the set has the box (Archive) and the box with an
 * arrow leaving it (Unarchive), but no box with an arrow going in, and its
 * artwork components are not exported. The lid and body paths are the icon set's
 * own Archive artwork, unchanged, so the pair still sits in the same family as
 * every other icon on this card; only the arrow is ours.
 *
 * The two must not drift apart: they share {@link LID} and {@link BODY}, and the
 * arrow differs only in {@link ARROW_OUT} versus {@link ARROW_IN} — same length,
 * same head, mirrored about the box's centre line.
 *
 * @module webdav-sync/client/BackupGlyph
 */

/** The box's lid: a wide flat cap, the line the eye reads as "a box". */
const LID =
  'M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z'

/** The box's body: the open container under the lid. */
const BODY =
  'M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5'

/** The arrow leaving the box: 导出, the setup going out to a file. */
const ARROW_OUT = 'M8 11.28V8.08M6.28 9.64L8 7.92L9.72 9.64'

/** The arrow entering the box: 导入, a file's setup coming in. */
const ARROW_IN = 'M8 7.92V11.28M6.28 9.56L8 11.28L9.72 9.56'

/** Which way the arrow inside the box points. */
export type BackupDirection = 'out' | 'in'

/**
 * One box, with the arrow turned the way this direction goes.
 *
 * Drawn at the size the card's icon buttons use (14px), stroked in
 * `currentColor` so the button's own colour, hover and disabled states carry
 * over without a second rule; hidden from assistive technology because the
 * button it sits in is named by the row's two words.
 *
 * @param props.direction - `out` for 导出, `in` for 导入.
 * @returns the glyph.
 */
export function BackupGlyph({ direction }: { direction: BackupDirection }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      strokeWidth={1}
      focusable="false"
    >
      <path d={LID} stroke="currentColor" />
      <path d={BODY} stroke="currentColor" />
      <path
        d={direction === 'out' ? ARROW_OUT : ARROW_IN}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
