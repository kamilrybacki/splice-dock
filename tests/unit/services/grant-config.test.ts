import {it,expect} from 'vitest';
import {readGrantConfig} from '../../../src/services/policy/grants/config.js';
it('ignores grant configuration when off and validates explicit enabled settings',()=>{
  expect(readGrantConfig({SPLICEDOCK_GRANT_THRESHOLD:'bad'})).toEqual({threshold:3,exceptions:undefined});
  expect(readGrantConfig({SPLICEDOCK_GRANTS:'1'})).toEqual({threshold:3,exceptions:undefined});
  for(const env of [{SPLICEDOCK_GRANT_THRESHOLD:'0'},{SPLICEDOCK_GRANT_THRESHOLD:'1.5'},{SPLICEDOCK_GRANT_EXCEPTIONS:'[{}]'}])expect(()=>readGrantConfig({SPLICEDOCK_GRANTS:'1',...env})).toThrow();
  expect(readGrantConfig({SPLICEDOCK_GRANTS:'1',SPLICEDOCK_GRANT_CONTEXT_MIN_SIM:'0'})).toEqual({threshold:3,exceptions:undefined});
});
