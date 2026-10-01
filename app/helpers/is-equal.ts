import { helper } from '@ember/component/helper';

export default helper(function eq([left, right]: [unknown, unknown]): boolean {
  return left === right;
});
