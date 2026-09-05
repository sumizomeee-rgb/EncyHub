import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNumericDraft, stepNumericValue } from '../src/utils/numericInput.js'

test('数字草稿允许负数并在提交时解析', () => {
    assert.equal(parseNumericDraft('-1', 'int'), -1)
    assert.equal(parseNumericDraft('-1.25', 'float'), -1.25)
})

test('数字草稿拒绝尚未完成或非法的输入', () => {
    assert.equal(parseNumericDraft('-', 'float'), null)
    assert.equal(parseNumericDraft('', 'float'), null)
    assert.equal(parseNumericDraft('abc', 'float'), null)
})

test('整数提交时截断小数部分', () => {
    assert.equal(parseNumericDraft('-1.9', 'int'), -1)
})

test('数字滚轮默认按 1 增减', () => {
    assert.equal(stepNumericValue('3', 'int', 1), 4)
    assert.equal(stepNumericValue('3', 'int', -1), 2)
    assert.equal(stepNumericValue('0.25', 'float', 1), 1.25)
})

test('数字滚轮忽略非法草稿', () => {
    assert.equal(stepNumericValue('-', 'float', 1), null)
})
