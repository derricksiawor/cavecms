import 'server-only'

// Safely serialize an object for embedding inside a
// <script type="application/ld+json"> tag via dangerouslySetInnerHTML.
// JSON.stringify alone is NOT enough -- it does not escape
// </script>, HTML comment delimiters, or the JavaScript line
// terminator code points U+2028 / U+2029. An admin (or any source
// feeding into the JSON) that contains a </script> substring would
// terminate the script tag and break out into HTML context. CSP
// strict-dynamic mitigates the executable consequence, but
// defense-in-depth requires that the bytes leaving this function be
// safe regardless of CSP posture.
//
// Use everywhere a JSON value gets inlined as inner HTML of a
// script tag. Pairs with tests/unit/seoEscape.test.ts.
//
// Replacements applied to the JSON.stringify output:
//   ASCII less-than          covers </script>, <!--, <![CDATA[
//   ASCII -->                covers HTML comment close
//   U+2028 line separator    breaks out of JS string literals
//   U+2029 paragraph sep     breaks out of JS string literals
//
// The U+2028/U+2029 cases use a regex built from a \u-escaped
// string -- pasting the literal characters into source is fragile
// because some editors strip them and they terminate single-line
// comments.
const LINE_TERMINATORS = new RegExp('[\\u2028\\u2029]', 'g')

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e')
    .replace(LINE_TERMINATORS, (ch) =>
      ch.charCodeAt(0) === 0x2028 ? '\\u2028' : '\\u2029',
    )
}
