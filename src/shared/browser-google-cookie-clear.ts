export type GoogleCookieClearResult = 'cleared' | 'empty' | 'remaining' | 'unverified'

export type GoogleCookieClearLocalTarget = {
  profileId: string
  environmentId: string | null
  partition: string
  routeIdentity: string | null
}
