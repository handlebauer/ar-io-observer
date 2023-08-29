/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { expect } from 'chai';

import { StaticArnsNamesSource } from './observer.js';

describe('StaticArnsNamesSource', () => {
  it('should return the correct names', async () => {
    const addresses = ['address1', 'address2', 'address3'];
    const source = new StaticArnsNamesSource(addresses);

    const names = await source.getNames();

    expect(names).to.deep.equal(addresses);
  });
});
