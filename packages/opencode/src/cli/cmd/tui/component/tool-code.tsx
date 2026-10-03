import { useTheme } from "@tui/context/theme"

export function ToolCode(props: { content: string; filetype?: string; streaming?: boolean }) {
  const { theme, syntax } = useTheme()
  return (
    <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
      <code
        conceal={false}
        fg={theme.text}
        filetype={props.filetype}
        syntaxStyle={syntax()}
        content={props.content}
        streaming={props.streaming}
      />
    </line_number>
  )
}
