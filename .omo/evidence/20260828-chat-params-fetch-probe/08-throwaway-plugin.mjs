export default async function FetchHeaderProbe() {
  return {
    'chat.params': async (_input, output) => {
      output.options.fetch = async (url, init) => {
        const response = await fetch(url, init)
        console.error('PROBE_HEADER=' + response.headers.get('x-9router-upstream-model'))
        return response
      }
      console.error('PROBE_CHAT_PARAMS_FETCH_SET')
    },
  }
}
