export function encryptFile(a: { srcPath: string; destPath: string; passphrase: string }): Promise<{ saltB64: string; ivB64: string; tagB64: string }>
export function decryptFile(a: { srcPath: string; destPath: string; passphrase: string; saltB64: string; ivB64: string; tagB64: string }): Promise<void>
