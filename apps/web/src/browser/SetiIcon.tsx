import './seti.css'

// Glyphs and colors from the VS Code 1.100.0 Seti light file icon theme.
// Keys beginning with a period also match the file's extension.
type Glyph = { char: string; color: string }
const fallback: Glyph = { char: '\uE023', color: '#627379' }
const groups = [
  ['\uE04C', '#9068b0', '.avif .bmp .gif .heic .heif .ico .jpeg .jpg .png .tif .tiff .webp'],
  ['\uE091', '#9068b0', '.svg .svgz'],
  ['\uE09B', '#dd4b78', '.avi .m4v .mkv .mov .mp4 .mpeg .mpg .ogv .webm .wmv'],
  ['\uE005', '#9068b0', '.aac .aif .aiff .flac .m4a .mp3 .oga .ogg .opus .wav'],
  ['\uE06D', '#b8383d', '.pdf'],
  ['\uE0A3', '#498ba7', '.doc .docx .odt .rtf'],
  ['\uE0A4', '#7fae42', '.ods .xls .xlsx'],
  ['\uE01E', '#7fae42', '.csv .tsv'],
  ['\uE060', '#498ba7', '.md .markdown .mdx'],
  ['\uE04D', '#498ba7', 'readme readme.md readme.txt'],
  ['\uE05A', '#b7b73b', 'license license.txt license.md copying'],
  ['\uE0A9', '#627379', '.7z .bz2 .gz .rar .tar .tgz .xz .zip'],
  ['\uE033', '#b8383d', '.otf .ttf .woff .woff2'],
  ['\uE025', '#498ba7', 'dockerfile .dockerfile'],
  ['\uE05F', '#cc6d2e', 'makefile gnumakefile'],
  ['\uE034', '#3b4b52', '.gitignore .gitattributes .gitmodules'],
  ['\uE019', '#627379', '.conf .ini .properties .toml'],
  ['\uE055', '#b7b73b', '.json .jsonc .jsonl'],
  ['\uE0A7', '#9068b0', '.yaml .yml'],
  ['\uE0A5', '#cc6d2e', '.xml'],
  ['\uE048', '#498ba7', '.htm .html'],
  ['\uE01D', '#498ba7', '.css'],
  ['\uE051', '#b7b73b', '.cjs .js .mjs'],
  ['\uE099', '#498ba7', '.cts .mts .ts'],
  ['\uE07D', '#498ba7', '.jsx .tsx'],
  ['\uE07B', '#498ba7', '.py'],
  ['\uE082', '#627379', '.rs'],
  ['\uE03A', '#498ba7', '.go'],
  ['\uE050', '#b8383d', '.java'],
  ['\uE00C', '#498ba7', '.c .h'],
  ['\uE01A', '#498ba7', '.cc .cpp .cxx .hpp'],
  ['\uE089', '#7fae42', '.bash .sh .zsh'],
] as const

const glyphs = new Map<string, Glyph>()
for (const [char, color, keys] of groups) {
  const glyph = { char, color }
  for (const key of keys.split(' ')) glyphs.set(key, glyph)
}

export default function SetiIcon({
  name,
  className,
  size,
}: {
  name: string
  className?: string
  size?: number
}) {
  const filename = name.toLowerCase()
  const suffixStart = filename.lastIndexOf('.')
  const extension = suffixStart >= 0 ? filename.slice(suffixStart) : ''
  const icon = glyphs.get(filename) ?? glyphs.get(extension) ?? fallback
  return (
    <span
      aria-hidden="true"
      className={className ? 'seti-icon ' + className : 'seti-icon'}
      style={{ color: icon.color, fontSize: size }}
    >
      {icon.char}
    </span>
  )
}
