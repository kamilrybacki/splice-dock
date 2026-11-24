import {it,expect} from 'vitest';
import {readGrantConfig} from '../../../src/services/policy/grants/config.js';
it('ignores grant configuration when off and validates explicit enabled settings',()=>{
  expect(readGrantConfig({SPLICEDOCK_GRANT_THRESHOLD:'bad'})).toMatchObject({threshold:2,minSimilarity:0.5});
  expect(readGrantConfig({SPLICEDOCK_GRANTS:'1'})).toMatchObject({threshold:2,minSimilarity:0.5,exceptions:undefined});
  for(const env of [{SPLICEDOCK_GRANT_THRESHOLD:'0'},{SPLICEDOCK_GRANT_CONTEXT_MIN_SIM:'0'},{SPLICEDOCK_GRANT_EXCEPTIONS:'[{}]'}])expect(()=>readGrantConfig({SPLICEDOCK_GRANTS:'1',...env})).toThrow();
});
