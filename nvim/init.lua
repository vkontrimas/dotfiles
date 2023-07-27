-- Plugin Manager Setup
require('plugins')

-- General Settings
vim.opt.termguicolors = true

vim.g.ayucolor = 'dark'
vim.cmd [[colorscheme ayu]]

vim.opt.number = true
vim.opt.relativenumber = true

vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.foldcolumn = '2'

vim.opt.colorcolumn = '80,120'

-- Key Mappings
vim.api.nvim_set_keymap('n', '<leader>h', '<C-W>h', { noremap = true })
vim.api.nvim_set_keymap('n', '<leader>j', '<C-W>j', { noremap = true })
vim.api.nvim_set_keymap('n', '<leader>k', '<C-W>k', { noremap = true })
vim.api.nvim_set_keymap('n', '<leader>l', '<C-W>l', { noremap = true })

vim.api.nvim_set_keymap('n', '<leader>b', ':b#<CR>', { noremap = true })

vim.api.nvim_set_keymap('n', '<leader>f', ':Files<CR>', { noremap = true })
vim.api.nvim_set_keymap('n', '<leader>r', ':Rg<CR>', { noremap = true })
vim.api.nvim_set_keymap('n', '<leader>t', ':BLines<CR>', { noremap = true })
vim.api.nvim_set_keymap('n', '<leader>g', ':Buffers<CR>', { noremap = true })

-- Plugin-Specific Settings
-- vim.g.clang_format#auto_format = 0
-- vim.api.nvim_set_keymap('n', '<Leader>C', ':ClangFormatAutoToggle<CR>', { noremap = true })

-- Enable Tree-sitter
require('nvim-treesitter.configs').setup {
  ensure_installed = {
    'lua',
    'bash',
    'c',
    'cpp',
    'comment',
    'cmake',
    'css',
    'javascript',
    'typescript',
    'dockerfile',
    'git_rebase',
    'gitcommit',
    'gitignore',
    'graphql',
    'java',
    'kotlin',
    'json',
    'kotlin',
    'markdown',
    'make',
    'ninja',
    'objc',
    'php',
    'proto',
    'python',
    'rust',
    'scala',
    'scss',
    'sql',
    'starlark',
    'swift',
    'yaml',
    'toml',
  },
  auto_install = true,
  highlight = {
    enable = true,
    additional_vim_regex_highlighting = false,
  },
}

-- Filetypes
vim.cmd[[au BufRead,BufNewFile *.gltf set filetype=json]]

