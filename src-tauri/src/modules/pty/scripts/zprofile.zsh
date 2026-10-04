# myko-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _myko_user_zdotdir="${MYKO_USER_ZDOTDIR:-$HOME}"
  [ -f "$_myko_user_zdotdir/.zprofile" ] && source "$_myko_user_zdotdir/.zprofile"
  unset _myko_user_zdotdir
}
:
