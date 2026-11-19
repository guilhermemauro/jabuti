/** A change as lines prefixed "+ ", "- " or "  ", added and removed lines marked. */
export function Diff(props: { text: string }) {
  return (
    <pre className="diff">
      {props.text.split("\n").map((line, i) => (
        <div key={i} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>
          {line}
        </div>
      ))}
    </pre>
  );
}
