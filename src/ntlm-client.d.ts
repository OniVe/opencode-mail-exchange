declare module "@ewsjs/ntlm-client" {
  export function createType1Message(workstation?: string, target?: string): string
  export function decodeType2Message(header: string): unknown
  export function createType3Message(
    type2Message: unknown,
    username: string,
    password: string,
    workstation?: string,
    target?: string,
  ): string
}
