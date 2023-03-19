call plug#begin('~/.config/nvim/plugged')
Plug 'ayu-theme/ayu-vim'

Plug 'tpope/vim-surround'
Plug 'junegunn/fzf.vim'
Plug 'junegunn/fzf'
Plug 'rhysd/vim-clang-format'

" JS
Plug 'pangloss/vim-javascript'
Plug 'leafgarland/typescript-vim'
Plug 'MaxMEllon/vim-jsx-pretty'
Plug 'jparise/vim-graphql'
call plug#end()

set termguicolors
let ayucolor='dark'
colorscheme ayu

set nu
set rnu

set tabstop=2
set shiftwidth=2
set expandtab
set foldcolumn=2

set colorcolumn=80,120

nnoremap <leader>h <C-W>h
nnoremap <leader>j <C-W>j
nnoremap <leader>k <C-W>k
nnoremap <leader>l <C-W>l

nnoremap <leader>b :b#<CR>

nnoremap <leader>f :Files<CR>
nnoremap <leader>r :Rg<CR>
nnoremap <leader>t :BLines<CR>
nnoremap <leader>g :Buffers<CR>

let g:clang_format#auto_format = 0
" nmap <Leader>C :ClangFormatAutoToggle<CR>
